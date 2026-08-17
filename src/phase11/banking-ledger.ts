/**
 * Phase 11 — THE BANKING LEDGER: double-entry, derived balances, one invariant.
 * Run: node src/phase11/banking-ledger.ts
 *
 * The problem in one line: debit account A and credit account B so that money is
 * never CREATED, DESTROYED, or DOUBLE-MOVED. The first design question is not
 * "SQL or NoSQL" — it's "can one database see both accounts?" Inside one trust
 * boundary, atomicity is FREE (one ACID transaction). Across boundaries it must
 * be MANUFACTURED (saga + suspense account + reconciliation — phase6's closing
 * contrast). This file is the one-boundary regime, done properly.
 *
 * THE DATA MODEL IS THE INVARIANT — an append-only DOUBLE-ENTRY journal:
 *
 *   entry(txnId, accountId, direction, amount, currency)
 *
 * Every transfer is written as legs that SUM TO ZERO: one debit + one credit,
 * appended together in the same atomic commit. Three consequences:
 *
 *   • BALANCES ARE DERIVED — a balance is a fold over the account's entries.
 *     The cached number in `accounts.balance` is just an aggregate, rebuildable
 *     by replay and AUDITABLE against it. `UPDATE accounts SET balance = balance
 *     - 500` as the primary record destroys history, loses updates under
 *     concurrency (phase6's demo B, with money), and makes "is the system
 *     correct right now?" unanswerable.
 *   • CORRECTIONS ARE REVERSING ENTRIES, never UPDATE/DELETE. The journal's
 *     immutability is the audit artifact regulators certify.
 *   • THE GLOBAL INVARIANT IS CHECKABLE: sum of ALL entries = 0, per currency.
 *     Money moved is always both a minus and a plus; anything else is a bug you
 *     can detect mechanically. (Cross-currency = two balanced sub-books joined
 *     by an FX account — you never sum across currencies.)
 *
 * TWO MORE LOAD-BEARING CHOICES:
 *
 *   • IDEMPOTENCY KEY IN THE COMMIT — the client mints the transfer ID; a
 *     unique constraint on it means a retried/duplicated request collapses in
 *     the SAME commit that moves the money. Idempotency and atomicity land
 *     together, not as separate best-effort layers.
 *   • THE DEBIT/CREDIT ASYMMETRY — debits need a SERIALIZED funds check (two
 *     concurrent ₹800 debits on ₹1,000 must not both pass — that's phase6's
 *     lost update wearing a suit). CREDITS ARE COMMUTATIVE: they append
 *     concurrently in any order and fold to the same sum. So you serialize
 *     debits per account and let credits flow — which is the whole answer to
 *     "what about the hot merchant account taking 10k credits/sec?"
 *     Escalation ladder when one account's DEBITS get hot: row lock → single-
 *     writer queue per account (contention becomes throughput) → sub-accounts
 *     netted periodically.
 *
 * Amounts are INTEGER MINOR UNITS (paise), never floats — 0.1 + 0.2 ≠ 0.3 is a
 * solvency bug, not a rounding quirk.
 *
 * We demo: (A) a transfer = atomic debit+credit pair, balance = fold of entries;
 * (B) a retried transfer with the same idempotency key → no double-move;
 * (C) a racing overdraft — naive read-then-write loses money, the version-check
 *     guard (phase6's CAS/OCC) makes the loser fail HONESTLY; (D) corrections as
 * reversing entries + the hot-account asymmetry; (E) the audit: global zero-sum
 * and replayed balances matching the cache — reconciliation proves correctness.
 *
 * TAKEAWAY: append-only double-entry with DERIVED balances makes correctness a
 * checkable property instead of a hope: every transfer sums to zero, the whole
 * book sums to zero, and any cached balance can be re-proven by replay.
 * Same boundary → one ACID commit with the idempotency key inside it; across
 * boundaries → saga + suspense, fail toward HOLDING money, never toward minting
 * it. Serialize only the debits (credits commute), correct by reversing — and
 * for money, slow-and-exactly-once beats instant-and-ambiguous.
 */

import { log } from "../lib/log.ts";

// ── The journal ──────────────────────────────────────────────────────────────

type Direction = "debit" | "credit";

interface Entry {
  seq: number;        // global append order — the journal is the log
  txnId: string;      // client-minted transfer ID (the idempotency key)
  accountId: string;
  direction: Direction;
  amount: number;     // integer paise, always positive; direction carries sign
  currency: string;
  memo: string;
}

/** Signed effect of an entry on its account: credit adds, debit removes. */
function signed(e: Entry): number {
  return e.direction === "credit" ? e.amount : -e.amount;
}

interface TransferResult {
  status: "applied" | "duplicate" | "rejected" | "conflict";
  txnId: string;
  detail: string;
}

/** A read taken before a debit — balance plus the version it was read at. */
interface DebitGuard {
  available: number;
  version: number; // seq of the account's newest entry when we read
}

const CURRENCY = "INR";
// The external world's account. Its (negative) balance is money in circulation
// inside our book; every paisa our users hold was credited FROM here, so the
// global sum over ALL entries — world included — stays exactly zero.
const WORLD = "world:cash-in";

function inr(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  return `${sign}₹${(Math.abs(paise) / 100).toFixed(2)}`;
}

class Ledger {
  private entries: Entry[] = [];              // append-only journal
  private seq = 0;
  private applied = new Map<string, TransferResult>(); // unique txnId → dedup
  private cached = new Map<string, number>(); // cached aggregate, NOT the truth

  /** DERIVED balance: fold the journal. This is the truth. */
  balanceOf(accountId: string): number {
    let sum = 0;
    for (const e of this.entries) if (e.accountId === accountId) sum += signed(e);
    return sum;
  }

  /** Cached balance — fast to read, but only an aggregate the audit re-proves. */
  cachedBalanceOf(accountId: string): number {
    return this.cached.get(accountId) ?? 0;
  }

  /** Read for a debit: available funds + the version the read was taken at. */
  readForDebit(accountId: string): DebitGuard {
    let version = 0;
    for (const e of this.entries) if (e.accountId === accountId) version = e.seq;
    return { available: this.balanceOf(accountId), version };
  }

  entryCount(): number { return this.entries.length; }
  allEntries(): readonly Entry[] { return this.entries; }

  /**
   * Commit a transfer: the whole block is one atomic unit (our single-threaded
   * stand-in for BEGIN…COMMIT). In order, exactly like the SQL in the design:
   *   1. UNIQUE(txnId) — duplicate delivery collapses inside the commit;
   *   2. version check on the debit account (the CAS from phase6) — if the
   *      account changed since `guard` was read, abort so the caller re-reads;
   *   3. funds check on the FRESH derived balance — the non-negative invariant;
   *   4. append debit + credit legs together — they sum to zero by construction.
   */
  commitTransfer(
    txnId: string, from: string, to: string, amount: number,
    memo: string, guard?: DebitGuard,
  ): TransferResult {
    // 1. Idempotency: the unique constraint on the client-minted transfer ID.
    const prior = this.applied.get(txnId);
    if (prior) {
      return { status: "duplicate", txnId, detail: `already ${prior.status}: ${prior.detail}` };
    }

    // 2. The debit account's serialization point (phase6's conditional write).
    if (guard) {
      const now = this.readForDebit(from);
      if (now.version !== guard.version) {
        return {
          status: "conflict", txnId,
          detail: `${from} changed since read (v${guard.version} → v${now.version}) — re-read and retry`,
        };
      }
    }

    // 3. Funds check on the fresh derived balance. The world account may go
    //    negative — that's money entering circulation, not an overdraft.
    if (from !== WORLD) {
      const available = this.balanceOf(from);
      if (available < amount) {
        const r: TransferResult = {
          status: "rejected", txnId,
          detail: `insufficient funds: ${inr(available)} < ${inr(amount)}`,
        };
        this.applied.set(txnId, r); // the rejection is recorded too — retries agree
        return r;
      }
    }

    // 4. Append both legs — one debit, one credit, summing to zero.
    const legs: Entry[] = [
      { seq: ++this.seq, txnId, accountId: from, direction: "debit", amount, currency: CURRENCY, memo },
      { seq: ++this.seq, txnId, accountId: to, direction: "credit", amount, currency: CURRENCY, memo },
    ];
    this.entries.push(...legs);
    this.cached.set(from, (this.cached.get(from) ?? 0) - amount);
    this.cached.set(to, (this.cached.get(to) ?? 0) + amount);

    const r: TransferResult = {
      status: "applied", txnId,
      detail: `${inr(amount)} ${from} → ${to} (entries #${legs[0].seq},#${legs[1].seq})`,
    };
    this.applied.set(txnId, r);
    return r;
  }

  /** The normal API: read → guarded commit → retry on conflict. */
  transfer(txnId: string, from: string, to: string, amount: number, memo: string): TransferResult {
    for (;;) {
      const guard = this.readForDebit(from);
      const r = this.commitTransfer(txnId, from, to, amount, memo, guard);
      if (r.status !== "conflict") return r;
    }
  }
}

// ── A) atomic debit+credit pair; balance = fold of entries ──────────────────

function demoA(ledger: Ledger): void {
  log("═══ A) A transfer is an atomic debit+credit pair; balance = fold ═══");

  // Money enters the book as transfers FROM the world account — even funding
  // is double-entry, so the global zero-sum holds from the very first entry.
  ledger.transfer("fund-alice", WORLD, "alice", 1000_00, "cash-in");
  ledger.transfer("fund-bob", WORLD, "bob", 500_00, "cash-in");
  log(`   funded: alice ${inr(ledger.balanceOf("alice"))}, bob ${inr(ledger.balanceOf("bob"))}, world ${inr(ledger.balanceOf(WORLD))} (money in circulation)`);

  const r = ledger.transfer("t-100", "alice", "bob", 250_00, "rent share");
  log(`   transfer t-100: ${r.detail}`);
  for (const e of ledger.allEntries()) {
    if (e.txnId !== "t-100") continue;
    log(`      journal #${e.seq}: ${e.direction.padEnd(6)} ${e.accountId.padEnd(6)} ${inr(e.amount)}  [txn ${e.txnId}]`);
  }
  const pairSum = ledger.allEntries().filter(e => e.txnId === "t-100").reduce((s, e) => s + signed(e), 0);
  log(`   the pair sums to ${inr(pairSum)} ✓ — money moved, none created or destroyed`);
  log(`   balances are DERIVED (fold of entries): alice ${inr(ledger.balanceOf("alice"))}, bob ${inr(ledger.balanceOf("bob"))}`);
  log(`   (floats would rot this: 0.1 + 0.2 = ${0.1 + 0.2} — hence integer paise)`);
  log("");
}

// ── B) retried transfer, same idempotency key → no double-move ──────────────

function demoB(ledger: Ledger): void {
  log("═══ B) Retry with the same idempotency key → no double-move ═══");
  const before = ledger.entryCount();

  // The client timed out and retries transfer t-100. Same client-minted ID.
  const retry = ledger.transfer("t-100", "alice", "bob", 250_00, "rent share");
  log(`   retry of t-100 → status=${retry.status} (${retry.detail})`);
  log(`   journal entries: ${before} before retry, ${ledger.entryCount()} after — nothing appended ✓`);
  log(`   alice still ${inr(ledger.balanceOf("alice"))} — the UNIQUE(txnId) check lives INSIDE the`);
  log("   same commit that moves money: dedup and atomicity land together.");
  log("");
}

// ── C) racing overdraft: naive loses money; the guard fails honestly ────────

function demoC(ledger: Ledger): void {
  log("═══ C) Two ₹800 debits race a ₹1,000 balance ═══");

  // NAIVE: balance as a mutable cell, read-then-write (phase6's lost update).
  {
    let balance = 1000_00;
    const t1Read = balance, t2Read = balance;      // both read ₹1,000
    if (t1Read >= 800_00) balance = t1Read - 800_00; // T1 check passes, writes
    if (t2Read >= 800_00) balance = t2Read - 800_00; // T2's STALE check also passes!
    log(`   NAIVE mutable balance: both funds checks passed on stale reads →`);
    log(`      final ${inr(balance)}, but ₹1,600 left the account ❌ money minted (lost update, phase6 B)`);
  }

  // LEDGER: alice has ₹750 from A/B; top up to ₹1,000 for the same race.
  ledger.transfer("fund-alice-2", WORLD, "alice", 250_00, "cash-in");
  log(`   LEDGER with debit guard: alice ${inr(ledger.balanceOf("alice"))}`);

  // Both transfers read the SAME snapshot before either commits — the race.
  const g1 = ledger.readForDebit("alice");
  const g2 = ledger.readForDebit("alice");
  log(`      T1 reads {available ${inr(g1.available)}, v${g1.version}}; T2 reads {available ${inr(g2.available)}, v${g2.version}}`);

  const r1 = ledger.commitTransfer("t-200", "alice", "carol", 800_00, "laptop", g1);
  log(`      T1 commit → ${r1.status}: ${r1.detail}`);

  const r2 = ledger.commitTransfer("t-201", "alice", "dave", 800_00, "bike", g2);
  log(`      T2 commit → ${r2.status}: ${r2.detail}`);

  // T2 retries the phase6 way: fresh read, fresh funds check — and fails HONESTLY.
  const g2b = ledger.readForDebit("alice");
  const r2b = ledger.commitTransfer("t-201", "alice", "dave", 800_00, "bike", g2b);
  log(`      T2 re-reads {available ${inr(g2b.available)}, v${g2b.version}} and retries → ${r2b.status}: ${r2b.detail}`);
  log(`   alice ${inr(ledger.balanceOf("alice"))} ✓ all debits pass ONE serialization point; the second`);
  log("   sees ₹200 and fails honestly. (Hotter than a row lock can take? Single-");
  log("   writer queue per account; hotter still? Sub-accounts, netted.)");
  log("");
}

// ── D) corrections reverse; credits commute (the hot-account asymmetry) ─────

function demoD(ledger: Ledger): void {
  log("═══ D) Corrections are reversing entries; credits commute ═══");

  // Refund t-100: never UPDATE/DELETE the journal — append the mirror pair.
  const refund = ledger.transfer("t-100-rev", "bob", "alice", 250_00, "reversal of t-100");
  log(`   refund of t-100 → ${refund.detail}`);
  log(`   original entries untouched; history shows charge AND reversal — that`);
  log("   immutability is the audit artifact. alice " +
      `${inr(ledger.balanceOf("alice"))}, bob ${inr(ledger.balanceOf("bob"))}`);

  // Hot merchant account: many payers credit it "at once". Credits are
  // commutative — the fold is the same in any order, so they never queue
  // behind the debit serialization point.
  const payers: Array<[string, number]> = [["bob", 40_00], ["carol", 75_00], ["dave", 60_00], ["alice", 25_00]];
  for (const [payer, amt] of payers) ledger.transfer(`pay-${payer}`, payer, "merchant", amt, "checkout");
  const inOrder = payers.reduce((s, [, a]) => s + a, 0);
  const reversed = [...payers].reverse().reduce((s, [, a]) => s + a, 0);
  log(`   4 payers credit merchant concurrently → ${inr(ledger.balanceOf("merchant"))}`);
  log(`   fold in arrival order = ${inr(inOrder)}, in reverse order = ${inr(reversed)} — identical ✓`);
  log("   serialize DEBITS per account; let credits flow. That asymmetry is the");
  log("   whole answer to \"merchant account, 10k credits/sec?\"");
  log("");
}

// ── E) the audit: reconciliation proves correctness ─────────────────────────

function demoE(ledger: Ledger): void {
  log("═══ E) Audit — the reconciliation loop that proves correctness ═══");
  const entries = ledger.allEntries();

  // 1. Per-transfer zero-sum: every txn's legs cancel exactly.
  const perTxn = new Map<string, number>();
  for (const e of entries) perTxn.set(e.txnId, (perTxn.get(e.txnId) ?? 0) + signed(e));
  const unbalanced = [...perTxn].filter(([, sum]) => sum !== 0);
  log(`   1) per-transfer zero-sum: ${perTxn.size} transfers, ${unbalanced.length} unbalanced ${unbalanced.length === 0 ? "✓" : "❌ SEV-0"}`);

  // 2. Global conservation: the whole book (world account included) sums to 0.
  const globalSum = entries.reduce((s, e) => s + signed(e), 0);
  log(`   2) global sum of all ${entries.length} entries = ${inr(globalSum)} ${globalSum === 0 ? "✓ money conserved" : "❌ SEV-0 stop-the-line"}`);

  // 3. Cached aggregates vs replay: rebuild every balance from history.
  const accounts = [...new Set(entries.map(e => e.accountId))].sort();
  let mismatches = 0;
  for (const a of accounts) {
    const replayed = ledger.balanceOf(a);
    const cachedBal = ledger.cachedBalanceOf(a);
    if (replayed !== cachedBal) mismatches++;
    log(`      ${a.padEnd(14)} cached ${inr(cachedBal).padStart(11)}  replayed ${inr(replayed).padStart(11)}  ${replayed === cachedBal ? "✓" : "❌"}`);
  }
  log(`   3) cached balances match replayed history: ${mismatches === 0 ? "all ✓" : `${mismatches} mismatches ❌`}`);
  log("   an unbalanced ledger is a sev-0; a bug you can't DETECT is a solvency");
  log("   question. Every failure mode must be reconciliation-visible.");
  log("");
}

function main(): void {
  const ledger = new Ledger();
  demoA(ledger);
  demoB(ledger);
  demoC(ledger);
  demoD(ledger);
  demoE(ledger);

  log("The ledger reflex: append-only double-entry, balances DERIVED, corrections");
  log("REVERSE → same boundary: one ACID commit, ordered locks, dedup-in-commit →");
  log("cross-boundary: saga, debit-first into a SUSPENSE account (in-flight money");
  log("has an address), idempotent credit, query-then-reverse → serialize debits");
  log("only, credits commute → reconciliation proves it; suspense AGE is the alarm.");
  log("Fail toward holding money, never toward minting it — and slow-and-exactly-");
  log("once beats instant-and-ambiguous.");
  process.exit(0);
}

main();
