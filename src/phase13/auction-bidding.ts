/**
 * Phase 13 — THE AUCTION: accepting bids on one hot row, and closing on time.
 * Run: node src/phase13/auction-bidding.ts
 *
 * The problem in one line: many people bid on one item at the same moment;
 * every bid must be recorded, exactly the right one must be leading, and no
 * bid may count after the auction ends. Volume is modest — the difficulty is
 * CONCENTRATION (hundreds of bids on one row in the final seconds) and TIMING.
 *
 * THE DATA MODEL — the log is the truth, the price is derived:
 *
 *   bids(auctionId, bidId, bidder, maxAmount, receivedAt, outcome)   append-only
 *   auction(status, endTime, highBidder, highMax, secondMax, price, version)
 *
 * Every bid is appended with its outcome, in the SAME commit that updates the
 * auction row. "My bid didn't count" then has a one-minute answer: read the log.
 *
 * PROXY BIDDING — a bidder enters the MAXIMUM they will pay; the system bids
 * for them. So the state to protect is not "the price" but the TOP TWO
 * maximums:
 *
 *   visible price = min(secondMax + increment, highMax)
 *
 * A new maximum above highMax takes the lead. One below it leaves the leader
 * in place but raises the price — and is outbid the instant it lands.
 *
 * THREE RULES CARRY THE DESIGN:
 *
 *   • THE WRITE CARRIES THE CHECK. Read-then-decide in application memory is a
 *     lost update (phase6): two bidders both read "high is 100", both decide
 *     they lead, the second write silently erases the first. The fix is a
 *     conditional write — apply only if the row is still at the version I read
 *     — and retry on a miss.
 *
 *   • THE SERVER'S RECEIPT TIME DECIDES VALIDITY. A bid counts iff
 *     receivedAt < endTime, stamped by OUR clock at the API. Not the client's
 *     clock, and not "whenever the close job happened to run".
 *
 *   • THE CLOSE IS FENCED. open → closed is itself a conditional write, so a
 *     close job that fires twice closes once.
 *
 * WHEN ONE AUCTION GOES HOT, optimistic retries thrash: with N bidders racing,
 * each round only one write wins and the rest retry. The escalation is the
 * same as phase11's hot account — SERIALIZE: route all bids for that auction
 * through one ordered writer (a log partition keyed by auctionId), which
 * applies them one at a time with no conflicts at all.
 *
 * We demo: (A) the naive lost update; (B) the conditional write fixing it;
 * (C) proxy bidding — leader holds, price rises; (D) a bid received after the
 * end is rejected even though the close job ran late, and a double close is a
 * no-op; (E) a hot auction — conflict retries vs a single writer.
 *
 * TAKEAWAY: the bid log is the truth and the price is derived. Accept bids
 * with a conditional write that updates state and appends the log together;
 * serialize a hot auction through one writer; let the server's receipt time,
 * not the close job, decide what counts.
 */

import { log } from "../lib/log.ts";

// ── The model ────────────────────────────────────────────────────────────────

type Outcome = "leading" | "outbid" | "too-low" | "late";

interface Bid {
  bidId: string;
  bidder: string;
  maxAmount: number;   // the most this bidder will pay (kept secret from others)
  receivedAt: number;  // stamped by the API server's clock
  outcome: Outcome;
}

interface AuctionRow {
  status: "open" | "closed";
  endTime: number;
  increment: number;
  highBidder: string | null;
  highMax: number;     // top maximum bid
  secondMax: number;   // second-highest maximum; drives the visible price
  price: number;       // what the leader would pay right now
  version: number;     // bumped on every change — the optimistic lock
}

const START_PRICE = 100;

function newAuction(endTime: number): AuctionRow {
  return { status: "open", endTime, increment: 5, highBidder: null, highMax: 0, secondMax: START_PRICE - 5, price: START_PRICE, version: 0 };
}

/** Pure rule: what does this bid do to the auction? Returns the next row and the bid's outcome. */
function applyBid(row: AuctionRow, bidder: string, maxAmount: number, receivedAt: number): { next: AuctionRow; outcome: Outcome } {
  if (row.status !== "open" || receivedAt >= row.endTime) return { next: row, outcome: "late" };
  if (maxAmount < row.price || (maxAmount === row.price && row.highBidder !== null)) return { next: row, outcome: "too-low" };
  const next = { ...row, version: row.version + 1 };
  if (maxAmount > row.highMax) {
    // New leader. The old leader's maximum becomes the price floor.
    next.secondMax = row.highBidder === null ? row.secondMax : row.highMax;
    next.highMax = maxAmount;
    next.highBidder = bidder;
    next.price = Math.min(next.secondMax + row.increment, maxAmount);
    return { next, outcome: "leading" };
  }
  // Beats the visible price but not the leader's secret maximum: price rises, leader holds.
  next.secondMax = maxAmount;
  next.price = Math.min(maxAmount + row.increment, row.highMax);
  return { next, outcome: "outbid" };
}

// ── The store: one auction row + its append-only bid log ─────────────────────

class AuctionStore {
  row: AuctionRow;
  readonly bids: Bid[] = [];
  conflicts = 0;

  constructor(endTime: number) {
    this.row = newAuction(endTime);
  }

  read(): AuctionRow {
    return { ...this.row };
  }

  /** Blind write: whatever I computed from my (possibly stale) read replaces the row. */
  blindWrite(next: AuctionRow, bid: Bid): void {
    this.row = next;
    this.bids.push(bid);
  }

  /** Conditional write: state + log commit together, only if nobody changed the row since I read it. */
  conditionalWrite(readVersion: number, next: AuctionRow, bid: Bid): boolean {
    if (this.row.version !== readVersion) { this.conflicts++; return false; }
    this.row = next;
    this.bids.push(bid);
    return true;
  }

  /** Fenced close: only the caller that flips open → closed wins. */
  close(): boolean {
    if (this.row.status !== "open") return false;
    this.row = { ...this.row, status: "closed", version: this.row.version + 1 };
    return true;
  }
}

let bidSeq = 0;
function mkBid(bidder: string, maxAmount: number, receivedAt: number, outcome: Outcome): Bid {
  return { bidId: `bid_${++bidSeq}`, bidder, maxAmount, receivedAt, outcome };
}

/** One bid through the optimistic path: read, decide, conditional write, retry on conflict. */
function placeBid(store: AuctionStore, bidder: string, maxAmount: number, receivedAt: number): { outcome: Outcome; attempts: number } {
  for (let attempts = 1; ; attempts++) {
    const read = store.read();
    const { next, outcome } = applyBid(read, bidder, maxAmount, receivedAt);
    if (store.conditionalWrite(read.version, next, mkBid(bidder, maxAmount, receivedAt, outcome))) return { outcome, attempts };
  }
}

const state = (r: AuctionRow) => `leader=${r.highBidder ?? "—"} price=$${r.price} (highMax=$${r.highMax}, secondMax=$${r.secondMax})`;

// ── (A) The naive lost update ────────────────────────────────────────────────

log("(A) NAIVE — Alice ($150) and Bob ($200) both read the row, then both write");
{
  const store = new AuctionStore(1_000);
  const aliceRead = store.read();
  const bobRead = store.read();                       // both see "no bids yet"
  const bob = applyBid(bobRead, "bob", 200, 10);
  store.blindWrite(bob.next, mkBid("bob", 200, 10, bob.outcome));
  const alice = applyBid(aliceRead, "alice", 150, 10); // computed from a stale read
  store.blindWrite(alice.next, mkBid("alice", 150, 10, alice.outcome));
  log(`   ${state(store.row)}`);
  log("   ❌ Bob's $200 maximum was erased: Alice leads at the start price, and both were told 'leading'");
}

// ── (B) Conditional write ────────────────────────────────────────────────────

log("");
log("(B) CONDITIONAL WRITE — same race, but the write is rejected if the row moved");
{
  const store = new AuctionStore(1_000);
  const aliceRead = store.read();
  const bobRead = store.read();
  const bob = applyBid(bobRead, "bob", 200, 10);
  store.conditionalWrite(bobRead.version, bob.next, mkBid("bob", 200, 10, bob.outcome));
  const stale = applyBid(aliceRead, "alice", 150, 10);
  const accepted = store.conditionalWrite(aliceRead.version, stale.next, mkBid("alice", 150, 10, stale.outcome));
  log(`   Alice's write on the stale read: ${accepted ? "accepted" : "REJECTED (version moved) → re-read and retry"}`);
  const retry = placeBid(store, "alice", 150, 10);
  log(`   Alice's retry outcome: ${retry.outcome}`);
  log(`   ${state(store.row)}`);
  log("   ✅ Bob leads; Alice's $150 became the second maximum, so Bob pays $155, not $200");
}

// ── (C) Proxy bidding ────────────────────────────────────────────────────────

log("");
log("(C) PROXY BIDDING — the leader's maximum is secret; rivals push the price, not the lead");
{
  const store = new AuctionStore(1_000);
  for (const [who, max] of [["bob", 200], ["carol", 120], ["dave", 180], ["erin", 210], ["frank", 100]] as const) {
    const { outcome } = placeBid(store, who, max, 20);
    log(`   ${who.padEnd(5)} max $${max} → ${outcome.padEnd(8)} | ${state(store.row)}`);
  }
  log(`   the log holds all ${store.bids.length} bids with outcomes, including the one that was too low`);
}

// ── (D) Closing: whose clock, and how many times ─────────────────────────────

log("");
log("(D) THE CLOSE — auction ends at t=1000; the close job doesn't run until t=1030");
{
  const store = new AuctionStore(1_000);
  placeBid(store, "bob", 200, 990);
  const sniper = placeBid(store, "zed", 500, 1_010);     // arrives after the end, before the close job
  log(`   zed bids $500 at t=1010 while the row still says status=${store.row.status}: outcome = ${sniper.outcome}`);
  const first = store.close();
  const second = store.close();                           // the scheduler fired twice
  log(`   close job at t=1030: first call closed=${first}, duplicate call closed=${second}`);
  log(`   winner: ${store.row.highBidder} at $${store.row.price}  ✅ validity came from receivedAt < endTime, not from when the job ran`);
}

// ── (E) A hot auction: optimistic retries vs a single writer ──────────────────

log("");
log("(E) HOT AUCTION — 40 bidders in the final second, each raising the maximum");
{
  const N = 40;
  // Optimistic: everyone reads the same version, then they write one after another.
  // Only one write per round succeeds; the rest must re-read and try again.
  const occ = new AuctionStore(1_000);
  let pending = Array.from({ length: N }, (_, i) => ({ bidder: `b${i}`, max: 200 + i * 5 }));
  let rounds = 0;
  let writes = 0;
  while (pending.length > 0) {
    rounds++;
    const snapshot = occ.read();
    const losers: typeof pending = [];
    for (const p of pending) {
      const { next, outcome } = applyBid(snapshot, p.bidder, p.max, 999);
      writes++;
      if (!occ.conditionalWrite(snapshot.version, next, mkBid(p.bidder, p.max, 999, outcome))) losers.push(p);
    }
    pending = losers;
  }
  // Single writer: bids are appended to a per-auction queue and applied in order.
  const serial = new AuctionStore(1_000);
  for (let i = 0; i < N; i++) placeBid(serial, `b${i}`, 200 + i * 5, 999);

  log(`   optimistic: ${writes} write attempts over ${rounds} rounds for ${N} bids — ${occ.conflicts} conflicts (work grows ~N²)`);
  log(`   single writer: ${N} writes, ${serial.conflicts} conflicts — one ordered consumer per auction`);
  log(`   both agree: ${state(occ.row)}`);
  log(`   same final state = ${JSON.stringify({ ...occ.row, version: 0 }) === JSON.stringify({ ...serial.row, version: 0 })}`);
}

log("");
log("TAKEAWAY: log + state in one conditional write; serialize the hot auction; the server's receipt time decides what counts.");
