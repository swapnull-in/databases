/**
 * Phase 9 — ISOLATION LEVELS: the anomaly ladder. Run: npm run phase9
 *
 * Phase 6 showed MVCC snapshots and the lost-update fix. This is the sequel: a
 * CATALOG of the anomalies concurrent transactions can suffer, and exactly which
 * isolation level forbids each one. An isolation level is a promise about which
 * anomalies you WON'T see. Stronger promises cost more (locks, aborts, retries),
 * so databases let you choose — and most default to something weaker than you'd
 * guess (Postgres/Oracle default to READ COMMITTED).
 *
 * The four classic anomalies, weakest to nastiest:
 *
 *   A) DIRTY READ — you read a value another txn wrote but hasn't committed; it
 *      then rolls back, so you acted on data that never existed.
 *   B) NON-REPEATABLE READ — you read a row, someone commits an UPDATE to it, you
 *      read the SAME row again and get a different value mid-transaction.
 *   C) PHANTOM READ — you run a range/predicate query (COUNT WHERE color='red'),
 *      someone commits a new ROW matching it, you re-run and the result grew.
 *   D) WRITE SKEW — two txns each read an overlapping set, each writes a DIFFERENT
 *      row, and together they break an invariant no single txn could break alone.
 *
 * The ladder — each level forbids one MORE anomaly than the one below it:
 *   READ UNCOMMITTED         → forbids nothing (allows all four)
 *   READ COMMITTED           → + no dirty reads
 *   REPEATABLE READ/SNAPSHOT → + no non-repeatable reads (still allows WRITE SKEW)
 *   SERIALIZABLE             → as if txns ran one at a time; forbids everything
 *
 * We reproduce each anomaly with a concrete T1/T2 interleaving we fully control,
 * then show the level that kills it. THE MONEY QUOTE: every level forbids one more
 * anomaly for a price. Name the anomaly you can't tolerate, then pick the WEAKEST
 * level that forbids it — don't pay for SERIALIZABLE if READ COMMITTED is enough.
 */

import { log } from "../lib/log.ts";

// ── A tiny scalar cell with MVCC versions + an uncommitted "pending" write ──
// Enough to demonstrate dirty reads (A) and non-repeatable reads (B).
class MvccCell {
  private versions: { value: number; commitTs: number }[];
  private clock = 0;
  private pending: { value: number; txn: string } | null = null;

  constructor(initial: number) {
    this.versions = [{ value: initial, commitTs: 0 }];
  }

  now(): number { return this.clock; }

  /** READ COMMITTED: newest committed value, ignoring anyone's pending write. */
  latestCommitted(): number { return this.versions[this.versions.length - 1].value; }

  /** REPEATABLE READ / SNAPSHOT: newest version committed at/before snapshotTs. */
  asOf(snapshotTs: number): number {
    let visible = this.versions[0].value;
    for (const v of this.versions) if (v.commitTs <= snapshotTs) visible = v.value;
    return visible;
  }

  /** READ UNCOMMITTED: the pending (dirty) write if one exists, else committed. */
  peekDirty(): number { return this.pending ? this.pending.value : this.latestCommitted(); }

  stage(txn: string, value: number): void { this.pending = { value, txn }; }
  rollback(): void { this.pending = null; }

  commit(): void {
    if (!this.pending) return;
    this.clock++;
    this.versions.push({ value: this.pending.value, commitTs: this.clock });
    this.pending = null;
  }

  /** Autocommit helper: stage a value and immediately commit it. */
  commitValue(value: number): void { this.stage("auto", value); this.commit(); }
}

// ── A tiny row table for range queries + an optional predicate ("range") lock ──
// Enough to demonstrate phantom reads (C) and write skew (D).
interface Rec { id: string; [field: string]: string | number | boolean }

class Table {
  private rows: Rec[] = [];
  private rangeLock: { by: string; pred: (r: Rec) => boolean } | null = null;

  seed(rows: Rec[]): void { for (const r of rows) this.rows.push({ ...r }); }

  count(pred: (r: Rec) => boolean): number { return this.rows.filter(pred).length; }

  /** A point-in-time copy — what a SNAPSHOT reader would have frozen at BEGIN. */
  snapshot(): Rec[] { return this.rows.map((r) => ({ ...r })); }

  lockRange(by: string, pred: (r: Rec) => boolean): void { this.rangeLock = { by, pred }; }
  unlock(): void { this.rangeLock = null; }

  /** Insert; blocked if a range lock covers the new row (the SERIALIZABLE fix). */
  insert(r: Rec): boolean {
    if (this.rangeLock && this.rangeLock.pred(r)) {
      log(`      ✗ SERIALIZABLE: insert of ${r.id} hits ${this.rangeLock.by}'s range lock → blocked`);
      return false;
    }
    this.rows.push({ ...r });
    return true;
  }

  update(id: string, patch: Partial<Rec>): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }
}

function dirtyReadDemo() {
  log("═══ A) DIRTY READ — reading another txn's UNCOMMITTED write ═══");
  const x = new MvccCell(100);
  log("   committed: x = 100");
  log("   T2: stages x = 999 (has written but NOT committed)");
  x.stage("T2", 999);
  log(`   T1 @ READ UNCOMMITTED reads x → ${x.peekDirty()}   ✗ DIRTY: sees T2's uncommitted 999`);
  log("   T2: ROLLBACK (abort/crash) — the 999 never existed");
  x.rollback();
  log(`   T1 acted on 999, but the real committed value is ${x.latestCommitted()}. Corruption.`);
  log("   ── fix: READ COMMITTED ──");
  x.stage("T2", 999); // T2 stages a dirty write again
  log(`   T2 stages x = 999 again; T1 @ READ COMMITTED reads x → ${x.latestCommitted()}   ✓ committed only`);
  x.rollback();
  log("   READ COMMITTED forbids dirty reads.");
  log("");
}

function nonRepeatableReadDemo() {
  log("═══ B) NON-REPEATABLE READ — same row read twice, two answers ═══");
  const x = new MvccCell(100);
  log("   T1 @ READ COMMITTED begins");
  log(`   T1 reads x → ${x.latestCommitted()}`);
  log("   T2 commits x = 200");
  x.commitValue(200);
  log(`   T1 reads x AGAIN → ${x.latestCommitted()}   ✗ NON-REPEATABLE: same query, new answer mid-txn`);
  log("   ── fix: REPEATABLE READ / SNAPSHOT ──");
  const y = new MvccCell(100);
  const t1Snap = y.now(); // T1 pins its snapshot at BEGIN
  log(`   T1 begins at snapshot ts=${t1Snap}; reads x → ${y.asOf(t1Snap)}`);
  log("   T2 commits x = 200");
  y.commitValue(200);
  log(`   T1 reads x again (still snapshot ts=${t1Snap}) → ${y.asOf(t1Snap)}   ✓ stable`);
  log("   REPEATABLE READ / SNAPSHOT forbids non-repeatable reads — but NOT write skew (see D).");
  log("");
}

function phantomReadDemo() {
  log("═══ C) PHANTOM READ — a new ROW appears in a repeated range query ═══");
  const isRed = (r: Rec) => r.color === "red";
  const t = new Table();
  t.seed([{ id: "w1", color: "red" }, { id: "w2", color: "red" }, { id: "w3", color: "blue" }]);
  log(`   T1 @ REPEATABLE READ counts WHERE color='red' → ${t.count(isRed)}`);
  log("   T2 inserts {w4, red} and commits");
  t.insert({ id: "w4", color: "red" });
  log(`   T1 re-counts WHERE color='red' → ${t.count(isRed)}   ✗ PHANTOM: a matching row appeared`);
  log("   (row snapshots froze the two rows, but nothing locked the RANGE color='red')");
  log("   ── fix: SERIALIZABLE (predicate / range lock, or SSI) ──");
  const t2 = new Table();
  t2.seed([{ id: "w1", color: "red" }, { id: "w2", color: "red" }, { id: "w3", color: "blue" }]);
  log(`   T1 @ SERIALIZABLE counts red → ${t2.count(isRed)}, and takes a range lock on color='red'`);
  t2.lockRange("T1", isRed);
  log("   T2 tries to insert {w4, red}...");
  t2.insert({ id: "w4", color: "red" });
  t2.unlock();
  log(`   T1 re-counts red → ${t2.count(isRed)}   ✓ no phantom`);
  log("   SERIALIZABLE forbids phantoms.");
  log("");
}

function writeSkewDemo() {
  log("═══ D) WRITE SKEW — disjoint writes that jointly break an invariant ═══");
  log("   invariant: at least ONE doctor on call.  Alice & Bob are both on call.");
  const onCall = (r: Rec) => r.onCall === true;
  const t = new Table();
  t.seed([{ id: "alice", onCall: true }, { id: "bob", onCall: true }]);
  log("   T1 (Alice wants off) and T2 (Bob wants off) run under SNAPSHOT ISOLATION");
  const t1Snap = t.snapshot(); // each txn reads its OWN snapshot at BEGIN
  const t2Snap = t.snapshot();
  log(`   T1 reads ${t1Snap.filter(onCall).length} on call → "Bob covers me" → T1 sets alice.onCall = false`);
  log(`   T2 reads ${t2Snap.filter(onCall).length} on call → "Alice covers me" → T2 sets bob.onCall  = false`);
  t.update("alice", { onCall: false }); // disjoint rows → no write-write conflict
  t.update("bob", { onCall: false });
  log(`   both commit (different rows → SI sees no conflict). on call now: ${t.count(onCall)}  ✗ INVARIANT BROKEN`);
  log("   ── fix: SERIALIZABLE (SSI detects the rw-dependency cycle) ──");
  const t3 = new Table();
  t3.seed([{ id: "alice", onCall: true }, { id: "bob", onCall: true }]);
  const t1Read = ["bob"], t1Write = ["alice"];
  const t2Read = ["alice"], t2Write = ["bob"];
  log(`   T1 read {${t1Read}} wrote {${t1Write}};  T2 read {${t2Read}} wrote {${t2Write}}`);
  const dangerousCycle =
    t1Read.some((k) => t2Write.includes(k)) && t2Read.some((k) => t1Write.includes(k));
  if (dangerousCycle) {
    log("   SSI: each txn read a row the other wrote → rw-antidependency cycle → ABORT T2 (retry)");
    t3.update("alice", { onCall: false }); // only T1 commits
  }
  log(`   on call now: ${t3.count(onCall)}  ✓ invariant holds`);
  log("   SNAPSHOT ISOLATION ALLOWS write skew; only SERIALIZABLE forbids it.");
  log("");
}

function ladder() {
  log("═══ THE ISOLATION LADDER — ✓ = forbidden (safe), ✗ = still allowed (anomaly possible) ═══");
  const cols = ["Dirty read", "Non-repeat", "Phantom", "Write skew"];
  // `allows[i] === true` means the anomaly is STILL POSSIBLE at that level.
  const rows: [string, boolean[]][] = [
    ["READ UNCOMMITTED", [true, true, true, true]],
    ["READ COMMITTED", [false, true, true, true]],
    ["REPEATABLE READ / SNAPSHOT", [false, false, true, true]],
    ["SERIALIZABLE", [false, false, false, false]],
  ];
  const W = 30, C = 13;
  const pad = (s: string, w: number) => s.padEnd(w);
  log("   " + pad("LEVEL", W) + cols.map((c) => pad(c, C)).join(""));
  for (const [name, allows] of rows) {
    log("   " + pad(name, W) + allows.map((a) => pad(a ? "✗ allow" : "✓ forbid", C)).join(""));
  }
  log("");
}

function main() {
  dirtyReadDemo();
  nonRepeatableReadDemo();
  phantomReadDemo();
  writeSkewDemo();
  ladder();
  log("Takeaways — each level forbids one MORE anomaly for a price:");
  log("   • READ COMMITTED             kills DIRTY READS (see only committed data)");
  log("   • REPEATABLE READ / SNAPSHOT kills NON-REPEATABLE READS (stable snapshot)");
  log("       ...but still ALLOWS WRITE SKEW — the trap that bites 'correct-looking' code");
  log("   • SERIALIZABLE               forbids EVERYTHING (phantoms + write skew too)");
  log("");
  log("The rule: name the anomaly you CAN'T tolerate, then pick the WEAKEST level that");
  log("forbids it. Don't pay for SERIALIZABLE if READ COMMITTED is enough — but if an");
  log("INVARIANT spans multiple rows (on-call, inventory, double-booking), only");
  log("SERIALIZABLE is safe, because SNAPSHOT ISOLATION lets write skew slip through.");
  process.exit(0);
}

main();
