/**
 * Phase 10 — PAGES & THE BUFFER POOL: the #1 OLTP performance predictor. Run: npm run phase10
 *
 * Your data does not live in RAM. It lives on disk, cut into fixed-size PAGES
 * (Postgres 8KB, InnoDB 16KB). To read a row the engine must get its page into
 * memory first. Fetching a page from disk is ~1000× slower than touching one
 * already in RAM — a RAM hit is ~0.1µs, a cold disk read is ~100µs. That gap is
 * the whole ballgame.
 *
 * So every database keeps a BUFFER POOL: an in-memory cache of hot pages, managed
 * as an LRU (least-recently-used) list. Ask for a page:
 *
 *   HIT  — it's already in the pool. Return it at RAM speed. Mark it most-recent.
 *   MISS — it's not. Read it from disk (slow), insert it, and if the pool is full
 *          EVICT the least-recently-used page to make room.
 *
 * The buffer pool is smaller than the disk (that's the point — RAM is scarce and
 * expensive). It works because real OLTP traffic is SKEWED: a small "hot set" of
 * pages — recent orders, active users, the top of every index — takes the vast
 * majority of accesses. If that hot set FITS in the pool, almost every request is
 * a hit and the database flies. If it doesn't, you fall off a cliff into disk.
 *
 * This file builds a real buffer pool (LRU + hit/miss counters + a latency model)
 * and shows two things every OLTP engineer must feel in their bones:
 *
 *   A) HIT RATIO vs POOL SIZE — sweep the pool from tiny to huge over a skewed
 *      workload. A pool holding just the hot pages already wins; growing past the
 *      working set buys almost nothing. The curve has a knee, not a slope.
 *
 *   B) THE SCAN CLIFF — a big full-table scan touches more distinct pages than the
 *      pool can hold, so it hits nothing AND evicts the hot set on its way through.
 *      Hit ratio collapses, average latency jumps toward raw disk speed, and every
 *      other query sharing that pool suddenly gets slow too.
 *
 * MONEY QUOTE: the single biggest OLTP performance question is "does the working
 * set fit in the buffer pool?" A hit is RAM-fast; a miss is ~1000× slower — so
 * your HIT RATIO, not your CPU, sets your throughput. And one careless big scan
 * can evict the hot set and tank everyone's latency.
 */

import { log } from "../lib/log.ts";

// ─── Latency model (microseconds). The 1000× gap is the entire lesson. ──────
const HIT_US = 0.1; //   page already in RAM — a pointer chase
const MISS_US = 100; //   page on disk — a random read, ~1000× slower

// ─── Seeded PRNG (mulberry32). Fixed seed ⇒ identical run every time. ────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── The buffer pool: an LRU cache of page numbers, with counters. ──────────
//     We model a page by its NUMBER (0..diskPages-1). We don't store bytes —
//     what matters for performance is only whether the page is resident.
class BufferPool {
  private readonly capacity: number; // pages the pool can hold
  // Map preserves insertion order; we use it as an LRU: oldest key = LRU victim.
  private readonly resident = new Map<number, true>();
  hits = 0;
  misses = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /** Access a page. Returns latency (µs) of hit vs miss. Updates LRU order. */
  access(page: number): number {
    if (this.resident.has(page)) {
      // HIT — refresh recency: delete + re-insert moves it to the newest slot.
      this.resident.delete(page);
      this.resident.set(page, true);
      this.hits++;
      return HIT_US;
    }
    // MISS — disk read, then insert; evict the LRU page if we're full.
    this.misses++;
    if (this.resident.size >= this.capacity) {
      const lru = this.resident.keys().next().value as number; // oldest inserted
      this.resident.delete(lru);
    }
    this.resident.set(page, true);
    return MISS_US;
  }

  hitRatio(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
  reset() {
    this.resident.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ─── Workload generators (seeded, deterministic) ────────────────────────────

/**
 * A SKEWED access: most requests land in a small HOT set, the rest scatter over
 * the cold tail. This is a stand-in for Zipf — the shape of real OLTP traffic.
 */
function skewedPage(rand: () => number, hotSet: number, diskPages: number): number {
  if (rand() < 0.9) {
    // 90% of accesses hit the hot set of `hotSet` pages
    return Math.floor(rand() * hotSet);
  }
  // 10% wander over the whole disk (the cold tail)
  return Math.floor(rand() * diskPages);
}

/** Run a skewed workload of `n` accesses through a pool; return avg latency µs. */
function runSkewed(pool: BufferPool, n: number, hotSet: number, diskPages: number, seed: number): number {
  const rand = mulberry32(seed);
  let totalUs = 0;
  for (let i = 0; i < n; i++) totalUs += pool.access(skewedPage(rand, hotSet, diskPages));
  return totalUs / n;
}

/** A full-table SCAN: touch `scanPages` distinct pages once each, in order. */
function runScan(pool: BufferPool, scanPages: number): number {
  let totalUs = 0;
  for (let p = 0; p < scanPages; p++) totalUs += pool.access(p);
  return totalUs / scanPages;
}

function bar(ratio: number, width = 24): string {
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}

function main() {
  const DISK_PAGES = 10_000; // the whole table on disk
  const HOT_SET = 200; //      the working set — the pages OLTP actually touches
  const ACCESSES = 100_000; //  requests in the skewed workload
  const SEED = 0x1a2b3c4d;

  log("═══ SETUP: a 10,000-page table, a 200-page hot set ═══");
  log(`   disk: ${DISK_PAGES.toLocaleString()} pages   working set (hot): ${HOT_SET} pages`);
  log(`   latency model: HIT ≈ ${HIT_US}µs (RAM)   MISS ≈ ${MISS_US}µs (disk) — a ${Math.round(MISS_US / HIT_US)}× gap`);
  log(`   workload: ${ACCESSES.toLocaleString()} accesses, 90% into the hot set (Zipf-ish, seeded)`);
  log("");

  // ─── A) HIT RATIO vs POOL SIZE ────────────────────────────────────────────
  log("═══ A) HIT RATIO vs POOL SIZE — sweep the pool over a SKEWED workload ═══");
  log("   pool size (% of hot set)        hit ratio                 avg latency");
  log("   ─────────────────────────────────────────────────────────────────────");
  const sizes = [0.05, 0.2, 0.5, 1.0, 2.0]; // fractions of the hot set
  for (const frac of sizes) {
    const cap = Math.max(1, Math.round(HOT_SET * frac));
    const pool = new BufferPool(cap);
    const avg = runSkewed(pool, ACCESSES, HOT_SET, DISK_PAGES, SEED);
    const label = `${cap} pages (${(frac * 100).toFixed(0)}%)`.padEnd(18);
    log(`   ${label}  ${bar(pool.hitRatio())} ${pct(pool.hitRatio())}   ${avg.toFixed(1).padStart(6)}µs`);
  }
  log("");
  log("   Read the KNEE: at 5% of the hot set the pool thrashes; by 100% almost");
  log("   every access is a RAM hit and latency has collapsed to near-zero.");
  log("   Past the working set (200%) the curve is flat — more RAM buys nothing.");
  log("   That knee is the answer to \"how much RAM does this database need?\"");
  log("");

  // ─── B) THE SCAN CLIFF ────────────────────────────────────────────────────
  log("═══ B) THE SCAN CLIFF — a big scan evicts the hot set and tanks latency ═══");
  const POOL = 250; //       comfortably holds the 200-page hot set, with headroom
  const SCAN_PAGES = 5_000; // a full-table-ish scan — 20× bigger than the pool
  const BURST = 300; //       a short burst of OLTP queries, measured warm vs cold

  // Warm the pool to steady state: the hot set is now resident.
  const oltp = new BufferPool(POOL);
  runSkewed(oltp, ACCESSES, HOT_SET, DISK_PAGES, SEED);

  // Measure a WARM burst of OLTP queries (reset counters, keep resident pages).
  // We use a fixed seed so this is the *exact same* query sequence as the cold
  // burst below — the only thing that changes is whether the pool is warm.
  oltp.hits = 0;
  oltp.misses = 0;
  const oltpAvg = runSkewed(oltp, BURST, HOT_SET, DISK_PAGES, SEED + 7);
  const oltpRatio = oltp.hitRatio();

  // Now a report/analyst fires a 5,000-page scan through the SAME pool. Reset the
  // counters (but keep resident pages) so we measure the SCAN in isolation.
  oltp.hits = 0;
  oltp.misses = 0;
  const scanAvg = runScan(oltp, SCAN_PAGES);
  const scanRatio = oltp.hitRatio();

  // The scan has evicted the hot set. Re-run the IDENTICAL OLTP burst — now COLD.
  oltp.hits = 0;
  oltp.misses = 0;
  const afterAvg = runSkewed(oltp, BURST, HOT_SET, DISK_PAGES, SEED + 7);
  const afterRatio = oltp.hitRatio();

  log(`   pool holds ${POOL} pages; hot set is ${HOT_SET}; the scan sweeps ${SCAN_PAGES.toLocaleString()} pages.`);
  log("");
  log("   phase                        hit ratio                 avg latency");
  log("   ─────────────────────────────────────────────────────────────────────");
  log(`   OLTP (hot set resident)      ${bar(oltpRatio)} ${pct(oltpRatio)}   ${oltpAvg.toFixed(1).padStart(6)}µs`);
  log(`   the SCAN itself              ${bar(scanRatio)} ${pct(scanRatio)}   ${scanAvg.toFixed(1).padStart(6)}µs  ← cliff`);
  log(`   OLTP right after the scan    ${bar(afterRatio)} ${pct(afterRatio)}   ${afterAvg.toFixed(1).padStart(6)}µs  ← collateral damage`);
  log("");
  log(`   The scan runs near disk speed (~${scanAvg.toFixed(0)}µs/access) because every page is a`);
  log("   miss. Worse: it flushed the hot set, so the OLTP traffic that shared the");
  log(`   pool went COLD too — its latency jumped from ${oltpAvg.toFixed(1)}µs to ${afterAvg.toFixed(1)}µs on the very`);
  log("   next queries. One scan taxed everyone. (Real engines fight this with a");
  log("   ring buffer for scans, so a seq-scan can't trample the LRU hot set.)");
  log("");

  log("═══ TAKEAWAYS ═══");
  log("   • Data lives on disk in fixed-size PAGES; the buffer pool is an LRU cache");
  log("     of the hot ones. A hit is RAM-fast; a miss is a disk read, ~1000× slower.");
  log("   • Because OLTP traffic is SKEWED, a small pool holding the working set wins");
  log("     almost every access. The hit-ratio curve has a KNEE at the working set.");
  log("   • The #1 OLTP performance question: does the working set fit in the pool?");
  log("     Hit ratio — not CPU — sets your throughput.");
  log("   • A big SCAN touches more pages than the pool holds: it hits nothing and");
  log("     evicts the hot set, tanking latency for every query sharing that pool.");
  process.exit(0);
}

main();
