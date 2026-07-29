/**
 * Phase 4 — REPLICATION & QUORUMS: tunable consistency. Run: npm run phase4
 *
 * To survive a node dying, every write is copied to N replicas. But if you don't
 * wait for all N on each write (slow, and impossible if one is down), replicas
 * disagree. Quorums are how you get a consistency guarantee anyway:
 *
 *   N = replicas per key
 *   W = replicas that must ACK a write before it's "done"
 *   R = replicas you read from, then take the newest version
 *
 *   THE RULE:  R + W > N  ⇒  every read set OVERLAPS every write set by at least
 *   one replica (pigeonhole). That overlapping replica has the latest write, and
 *   since reads take the highest version, you always see the newest value.
 *   Read-your-writes, guaranteed — without waiting for all N.
 *
 *   R + W ≤ N  ⇒  a read set can completely miss the last write → STALE reads.
 *
 * Tuning:  W=N (durable, slow writes) · W=1 (fast writes, weak durability, easy
 * to lose data if that node dies) · R=1,W=N (fast reads) · R=W=⌈(N+1)/2⌉ (balanced).
 *
 * We run N=3 and show a stale read at W=1,R=1, then consistency at W=2,R=2.
 */

import { log } from "../lib/log.ts";

interface Versioned { value: string; version: number }

class QuorumStore {
  private replicas: Array<Map<string, Versioned>>;
  readonly N: number;

  constructor(n: number) {
    this.N = n;
    this.replicas = Array.from({ length: n }, () => new Map());
  }

  /** Write to the first W replicas only (simulating the others lagging/down). */
  write(key: string, value: string, version: number, W: number) {
    for (let i = 0; i < W; i++) this.replicas[i].set(key, { value, version });
    log(`   WRITE "${value}" (v${version}) to ${W} of ${this.N} replicas`);
  }

  /** Read from the LAST R replicas, return the highest version seen. */
  read(key: string, R: number): Versioned | undefined {
    const queried = this.replicas.slice(this.N - R); // read a different subset
    let newest: Versioned | undefined;
    for (const rep of queried) {
      const v = rep.get(key);
      if (v && (!newest || v.version > newest.version)) newest = v;
    }
    log(`   READ from ${R} of ${this.N} replicas → ${newest ? `"${newest.value}" (v${newest.version})` : "nothing"}`);
    return newest;
  }
}

function demo(N: number, W: number, R: number, label: string) {
  const overlaps = R + W > N;
  log(`═══ ${label}: N=${N}, W=${W}, R=${R}  →  R+W=${R + W} ${overlaps ? ">" : "≤"} N ═══`);
  const store = new QuorumStore(N);
  store.write("x", "old", 1, N); // seed all replicas with old value
  store.write("x", "new", 2, W); // update, acked by only W replicas
  const got = store.read("x", R);
  log(`   result: read got "${got?.value}" — ${got?.value === "new" ? "✓ fresh" : "❌ STALE (missed the last write)"}`);
  log(`   ${overlaps ? "R+W>N guarantees the read set overlaps the write set." : "R+W≤N: the read subset can miss the write subset entirely."}`);
  log("");
}

function main() {
  demo(3, 1, 1, "Fast but unsafe");   // R+W=2 ≤ 3 → can be stale
  demo(3, 2, 2, "Balanced quorum");   // R+W=4 > 3 → always fresh
  log("Same 3 replicas, same data — only the quorum numbers changed. That single");
  log("inequality (R+W>N) is the dial from 'eventually consistent & fast' to");
  log("'strongly consistent & slower'. Dynamo/Cassandra expose R and W per query.");
  process.exit(0);
}

main();
