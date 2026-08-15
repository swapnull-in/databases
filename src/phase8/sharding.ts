/**
 * Phase 8 — SHARDING: strategies, resharding, and the hot partition.
 * Run: npm run phase8
 *
 * One machine can't hold the data or the traffic, so you SPLIT the keyspace
 * across N shards. The hard part isn't the split — it's what happens when N
 * changes (you add a machine) and what happens when the load is NOT uniform.
 * This script demonstrates the three things a Staff engineer must be able to
 * reason about, all on a fixed 10,000-key set with one deterministic hash:
 *
 *   A) STRATEGIES & RESHARDING — how you place keys, and how many keys have to
 *      MOVE when you grow N=4 → N=5. This is the whole game, because moving a
 *      key means copying its data across the network.
 *        • HASH-MOD  shard = hash(key) % N — dead simple, but changing N
 *          rehashes almost EVERYTHING (a "miss storm": ~80% of keys move).
 *        • RANGE     contiguous key ranges — growing splits ONE range, so only
 *          a bounded slice moves. Great for scans, but prone to hot ranges.
 *        • CONSISTENT HASHING  keys and nodes on a ring — a new node steals only
 *          the arc in front of it, so only ~1/N of keys move.
 *
 *   B) VIRTUAL SHARDS (the production fix) — pin keys to a FIXED, large number
 *      of virtual shards (256) that never changes, then keep a small table
 *      mapping vshard → physical node. Adding a node reassigns whole vshards
 *      (a bounded ~1/N set) by editing the table — NO key is ever individually
 *      rehashed. This is how Vitess, Citus, and Dynamo actually rebalance.
 *
 *   C) HOT PARTITION & WRITE-SHARDING — one "celebrity" key takes a huge share
 *      of writes, so its shard melts no matter how evenly you shard. The fix
 *      isn't rebalancing — it's WRITE-SHARDING: append a bounded suffix
 *      (key#0..key#M) so writes scatter across M sub-keys, and reads
 *      scatter-gather across them.
 *
 * TAKEAWAY: hash-mod is simple but rehashes everything on a resize; consistent
 * hashing and FIXED VIRTUAL SHARDS move only ~1/N and let you rebalance by
 * reassigning whole vshards, not keys; and a hot partition needs write-sharding
 * (key-suffix scatter-gather), because no rebalancing scheme helps a single
 * overloaded key.
 */

import { log } from "../lib/log.ts";

// ── A deterministic 32-bit FNV-1a hash — the same one Phase 5's ring uses. ──
// No Math.random, no Date.now: every run of this file prints identical numbers.
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// A fixed keyset. Zero-padding makes lexical order == numeric order, so the
// RANGE strategy can carve the sorted keyspace by key index cleanly.
const KEYS: string[] = Array.from({ length: 10000 }, (_, i) => `key:${String(i).padStart(5, "0")}`);
const keyIndex = (key: string) => Number(key.slice(4)); // "key:01234" → 1234

const pct = (n: number, total: number) => `${((n / total) * 100).toFixed(1)}%`;

/** Count how many keys land on a different shard when the assignment changes. */
function countRemapped(before: (key: string) => number | string, after: (key: string) => number | string): number {
  let moved = 0;
  for (const key of KEYS) if (before(key) !== after(key)) moved++;
  return moved;
}

// ════════════════════════════════════════════════════════════════════════════
// A) STRATEGIES — assign 10,000 keys, then grow N=4 → N=5 and count who moves.
// ════════════════════════════════════════════════════════════════════════════

// (1) HASH-MOD: shard = hash(key) % N. Trivial, and catastrophic on resize.
const hashMod = (N: number) => (key: string) => hash(key) % N;

// (2) RANGE: contiguous slices of the sorted keyspace. Boundaries are the cut
// points (a key with index >= a boundary sits above it). Growing the cluster
// SPLITS the largest range in half — only that half's keys move, not the world.
function rangeShard(boundaries: number[]) {
  return (key: string) => {
    const idx = keyIndex(key);
    let s = 0;
    for (const b of boundaries) if (idx >= b) s++;
    return s;
  };
}
const RANGE_4 = [2500, 5000, 7500];                 // 4 equal ranges of 2500 keys
const RANGE_5 = [2500, 5000, 7500, 8750];           // split the last range at its midpoint

// (3) CONSISTENT HASHING: place each node at many points on a 2^32 ring; a key
// belongs to the first node point clockwise. A new node inserts its own points
// and only steals the arcs immediately in front of them (~1/N of the ring).
const RING_REPLICAS = 160; // virtual ring points per physical node → even spread
function buildRing(nodeIds: string[]): Array<{ point: number; node: string }> {
  const ring: Array<{ point: number; node: string }> = [];
  for (const id of nodeIds)
    for (let r = 0; r < RING_REPLICAS; r++) ring.push({ point: hash(`${id}#${r}`), node: id });
  ring.sort((a, b) => a.point - b.point);
  return ring;
}
function ringShard(ring: Array<{ point: number; node: string }>) {
  return (key: string) => {
    const h = hash(key);
    // First ring point whose position >= the key's position; wrap to the start.
    for (const slot of ring) if (slot.point >= h) return slot.node;
    return ring[0].node;
  };
}

function partA() {
  log("═══ A) STRATEGIES: grow N=4 → N=5, count keys that must MOVE ═══");
  log(`   keyset: ${KEYS.length} keys, one fixed FNV-1a hash`);
  log("");

  const hm = countRemapped(hashMod(4), hashMod(5));
  log(`   (1) HASH-MOD        hash(key) % N`);
  log(`       remapped: ${hm} / ${KEYS.length} = ${pct(hm, KEYS.length)}  ← miss storm: almost everything moves`);

  const rg = countRemapped(rangeShard(RANGE_4), rangeShard(RANGE_5));
  log(`   (2) RANGE           contiguous key ranges, grow = split one range`);
  log(`       remapped: ${rg} / ${KEYS.length} = ${pct(rg, KEYS.length)}  ← bounded: only the split range's keys move`);

  const ring4 = buildRing(["shard0", "shard1", "shard2", "shard3"]);
  const ring5 = buildRing(["shard0", "shard1", "shard2", "shard3", "shard4"]);
  const ch = countRemapped(ringShard(ring4), ringShard(ring5));
  log(`   (3) CONSISTENT HASH ring, new node steals only the arc in front of it`);
  log(`       remapped: ${ch} / ${KEYS.length} = ${pct(ch, KEYS.length)}  ← ~1/N (1/5 = 20%), the good target`);
}

// ════════════════════════════════════════════════════════════════════════════
// B) VIRTUAL SHARDS — pin keys to 256 fixed vshards, move whole vshards on grow.
// ════════════════════════════════════════════════════════════════════════════

const VSHARDS = 256;
// A key's vshard is fixed FOREVER — it never changes when the cluster resizes.
const vshardOf = (key: string) => hash(key) % VSHARDS;

/** vshard → node table for N nodes (round-robin start). This tiny array is the
 *  only thing we edit to rebalance; keys never learn that anything moved. */
function initTable(N: number): number[] {
  return Array.from({ length: VSHARDS }, (_, v) => v % N);
}

/** Add one node (index oldN). Shed each existing node's EXCESS vshards to it,
 *  so every node ends up with ~256/newN. Returns the set of vshards that moved. */
function addNode(table: number[], oldN: number): Set<number> {
  const newN = oldN + 1;
  const target = Math.floor(VSHARDS / newN);
  const moved = new Set<number>();
  for (let node = 0; node < oldN; node++) {
    const owned = table.map((n, v) => (n === node ? v : -1)).filter((v) => v >= 0);
    for (const v of owned.slice(target)) { // keep `target`, move the rest to the new node
      table[v] = oldN;
      moved.add(v);
    }
  }
  return moved;
}

function partB() {
  log("");
  log("═══ B) VIRTUAL SHARDS: 256 fixed vshards, edit a table instead of rehashing ═══");

  // How many real keys live in each vshard (fixed, computed once).
  const keysPerVshard = new Array<number>(VSHARDS).fill(0);
  for (const key of KEYS) keysPerVshard[vshardOf(key)]++;

  const table = initTable(4);
  log(`   4 nodes × ${VSHARDS / 4} vshards each; key→vshard is hash(key) % ${VSHARDS} (never changes)`);

  const movedVshards = addNode(table, 4);
  let movedKeys = 0;
  for (const v of movedVshards) movedKeys += keysPerVshard[v];

  log(`   add a 5th node → reassign whole vshards by editing the table:`);
  log(`       vshards moved: ${movedVshards.size} / ${VSHARDS} = ${pct(movedVshards.size, VSHARDS)}  (~1/N)`);
  log(`       keys carried along: ${movedKeys} / ${KEYS.length} = ${pct(movedKeys, KEYS.length)}`);
  log(`       keys individually REHASHED: 0  ← the whole point`);
  log(`   Contrast with A(1): hash-mod moved ~80% of keys; the vshard table moves ~1/N`);
  log(`   and rebalances by reassigning vshards, never by rehashing a single key.`);
}

// ════════════════════════════════════════════════════════════════════════════
// C) HOT PARTITION — one celebrity key melts its shard; write-sharding fixes it.
// ════════════════════════════════════════════════════════════════════════════

const SHARDS_C = 8;
const CELEB = "key:celebrity";
const FANOUT = 16;          // M: sub-keys to scatter the celebrity's writes across
const CELEB_WRITES = 60000; // the celebrity hogs 60% of all writes...
const SPREAD_WRITES = 40000; // ...the rest are spread over ordinary keys

function loadStats(load: number[]) {
  const total = load.reduce((a, b) => a + b, 0);
  const max = Math.max(...load);
  const avg = total / load.length;
  return { max, avg, hotRatio: max / avg };
}

function partC() {
  log("");
  log("═══ C) HOT PARTITION: a celebrity key, then WRITE-SHARDING scatter-gather ═══");
  log(`   ${SHARDS_C} shards, ${CELEB_WRITES + SPREAD_WRITES} writes; "${CELEB}" takes ${CELEB_WRITES}`);

  // ── BEFORE: every celebrity write hits the ONE shard that owns its key. ──
  const before = new Array<number>(SHARDS_C).fill(0);
  const celebShard = hash(CELEB) % SHARDS_C;
  before[celebShard] += CELEB_WRITES;
  for (let j = 0; j < SPREAD_WRITES; j++) before[hash(KEYS[j % KEYS.length]) % SHARDS_C]++;
  const b = loadStats(before);
  log("");
  log(`   BEFORE (plain key): per-shard writes = [${before.join(", ")}]`);
  log(`       shard ${celebShard} is the hotspot: ${before[celebShard]} writes, hot-ratio ${b.hotRatio.toFixed(2)}× the average`);

  // ── AFTER: write-sharding — the celebrity's writes fan out over FANOUT
  // sub-keys ("key:celebrity#0".."#15"), each hashing to (usually) a different
  // shard. Reads must scatter-gather across all FANOUT sub-keys and merge. ──
  const after = new Array<number>(SHARDS_C).fill(0);
  for (let j = 0; j < CELEB_WRITES; j++) after[hash(`${CELEB}#${j % FANOUT}`) % SHARDS_C]++;
  for (let j = 0; j < SPREAD_WRITES; j++) after[hash(KEYS[j % KEYS.length]) % SHARDS_C]++;
  const a = loadStats(after);
  log("");
  log(`   AFTER (write-shard ×${FANOUT}): per-shard writes = [${after.join(", ")}]`);
  log(`       peak shard now ${a.max} writes, hot-ratio ${a.hotRatio.toFixed(2)}× — the hotspot is gone`);
  log(`       reads pay for it: a celebrity read now scatter-gathers ${FANOUT} sub-keys and merges.`);
}

function main() {
  partA();
  partB();
  partC();

  log("");
  log("Takeaways:");
  log("  • HASH-MOD is one line but rehashes ~everything on resize — never grow a");
  log("    live cluster this way. RANGE moves a bounded slice; CONSISTENT HASH ~1/N.");
  log("  • FIXED VIRTUAL SHARDS are the production answer: keys pin to vshards for");
  log("    life, and you rebalance by reassigning whole vshards in a table — 0 keys");
  log("    rehashed. This is how Vitess, Citus, and Dynamo move data.");
  log("  • A HOT PARTITION is a different problem: no sharding scheme saves a single");
  log("    overloaded key. Write-shard it (key#0..key#M scatter-gather) instead.");
  process.exit(0);
}

main();
