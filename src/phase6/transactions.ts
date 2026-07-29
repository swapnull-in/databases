/**
 * Phase 6 — TRANSACTIONS: MVCC, isolation, and contention. Run: npm run phase6
 *
 * A transaction is "these operations happen all-or-nothing, and concurrent
 * transactions don't corrupt each other." The hard part is the second clause.
 *
 * MVCC (Multi-Version Concurrency Control) — instead of locking rows for reads,
 * keep MULTIPLE VERSIONS of each row, each tagged with the commit timestamp that
 * created it. A transaction reads as-of the SNAPSHOT it started with, so its
 * reads are stable even while others commit. Readers never block writers and
 * writers never block readers. This is how Postgres and MySQL/InnoDB work.
 *
 * ISOLATION LEVELS — how much anomaly you tolerate for speed. Each level forbids
 * one more anomaly:
 *   READ COMMITTED  → no dirty reads (never see uncommitted data)
 *   SNAPSHOT/REPEATABLE READ → + no non-repeatable reads (stable snapshot); still
 *                     allows WRITE SKEW
 *   SERIALIZABLE    → as if transactions ran one at a time; forbids everything
 *
 * THE CONTENTION LADDER — when two txns fight over the same row, climb only as
 * high as you must: conditional write (CAS) → row lock → OCC/retry → serialize.
 *
 * We demo (A) a stable MVCC snapshot, and (B) a lost update + the CAS fix.
 */

import { log } from "../lib/log.ts";

interface Version { value: number; commitTs: number }

class MVCCStore {
  private versions = new Map<string, Version[]>(); // newest last
  private clock = 0;

  constructor(seed: Record<string, number>) {
    for (const [k, v] of Object.entries(seed)) this.versions.set(k, [{ value: v, commitTs: 0 }]);
  }

  now() { return this.clock; }

  /** Read the newest version committed at or before `snapshotTs`. */
  read(key: string, snapshotTs: number): number {
    const chain = this.versions.get(key) ?? [];
    let visible = 0;
    for (const v of chain) if (v.commitTs <= snapshotTs) visible = v.value;
    return visible;
  }

  /** Commit a new version. With OCC, reject if the row changed since `readTs`. */
  commit(key: string, value: number, readTs?: number): boolean {
    const chain = this.versions.get(key) ?? [];
    const latestTs = chain.length ? chain[chain.length - 1].commitTs : 0;
    if (readTs !== undefined && latestTs > readTs) {
      log(`      ✗ OCC conflict on ${key}: it changed (ts${latestTs} > read ts${readTs}) → abort & retry`);
      return false;
    }
    this.clock++;
    chain.push({ value, commitTs: this.clock });
    this.versions.set(key, chain);
    return true;
  }
}

function snapshotDemo() {
  log("═══ A) MVCC snapshot isolation: T1's reads stay stable ═══");
  const db = new MVCCStore({ x: 100 });

  const t1Snapshot = db.now(); // T1 begins
  log(`   T1 begins at snapshot ts=${t1Snapshot}; reads x = ${db.read("x", t1Snapshot)}`);

  log("   T2 writes x=200 and commits...");
  db.commit("x", 200); // T2 commits a new version

  log(`   T1 reads x again → ${db.read("x", t1Snapshot)}  ✓ still sees its snapshot (repeatable read)`);
  log(`   a NEW transaction reads x → ${db.read("x", db.now())}  (sees the committed 200)`);
  log("");
}

function lostUpdateDemo() {
  log("═══ B) Lost update, and the conditional-write (CAS) fix ═══");

  // Naive: two transfers both read 100, both write 100+amount → one is lost.
  {
    const db = new MVCCStore({ balance: 100 });
    const t1Read = db.read("balance", db.now()); // both read the same snapshot
    const t2Read = db.read("balance", db.now());
    db.commit("balance", t1Read + 50); // T1: 100 → 150
    db.commit("balance", t2Read + 30); // T2: also based on 100 → 130 (clobbers T1!)
    log(`   NAIVE: two deposits (+50, +30) onto 100 → final ${db.read("balance", db.now())}  ❌ (should be 180; T1's +50 lost)`);
  }

  // Fixed with OCC: commit checks the row hasn't changed since we read it.
  {
    const db = new MVCCStore({ balance: 100 });
    const t1ReadTs = db.now(), t1Read = db.read("balance", t1ReadTs);
    const t2ReadTs = db.now(), t2Read = db.read("balance", t2ReadTs);
    db.commit("balance", t1Read + 50, t1ReadTs); // T1 succeeds → balance v@ts1
    const ok = db.commit("balance", t2Read + 30, t2ReadTs); // T2's readTs is stale → rejected
    if (!ok) {
      const fresh = db.read("balance", db.now()); // T2 retries on fresh value
      db.commit("balance", fresh + 30, db.now());
    }
    log(`   OCC:   same two deposits → final ${db.read("balance", db.now())}  ✓ (T2 retried on the fresh value)`);
  }
  log("");
}

function main() {
  snapshotDemo();
  lostUpdateDemo();
  log("The contention ladder — climb only as high as the conflict demands:");
  log("   1. conditional write (CAS/OCC) — cheapest; great under LOW contention");
  log("   2. row lock (pessimistic)      — when conflicts are frequent");
  log("   3. OCC with retry loop         — read-heavy, occasional writes");
  log("   4. serialize (queue/serializable txns) — when correctness > throughput");
  log("");
  log("And the classic contrast: a same-bank transfer is ONE transaction (atomic");
  log("debit+credit); a cross-bank transfer can't be — it's a SAGA with");
  log("compensating actions, because you can't hold a lock across two banks.");
  process.exit(0);
}

main();
