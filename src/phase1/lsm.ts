/**
 * Phase 1 — THE LSM-TREE storage engine, from scratch. Run: npm run phase1
 *
 * Under every database is a "storage engine" answering two questions: where do
 * writes go, and how do reads find them. There are two families. This is the
 * LSM-tree (Log-Structured Merge-tree) — what Cassandra, RocksDB, LevelDB,
 * ScyllaDB, and most write-heavy stores use. (Phase 3 contrasts it with B-trees.)
 *
 * The core idea: NEVER do random writes to disk (slow). Instead:
 *
 *   WRITE PATH — put the key in an in-memory sorted map (the MEMTABLE). That's
 *     it. Writes are O(log n) in memory, blazing fast. When the memtable gets
 *     big, FLUSH it to disk as an immutable, sorted file (an SSTable) in one
 *     sequential pass. Old data is never modified in place — new writes just
 *     stack newer SSTables on top.
 *
 *   READ PATH — check the memtable first (newest data). Miss? Check SSTables
 *     newest→oldest until you find the key. The first hit wins (it's the latest).
 *
 *   DELETE — you can't remove from an immutable file, so you write a TOMBSTONE
 *     (a "deleted" marker). Reads that hit a tombstone first return "not found".
 *
 *   COMPACTION — over time you have many overlapping SSTables (slow reads, wasted
 *     space). A background merge combines them, keeping only the newest value per
 *     key and dropping tombstones. This is the LSM's housekeeping tax.
 */

import { log } from "../lib/log.ts";

const TOMBSTONE = Symbol("tombstone");
type Value = string | typeof TOMBSTONE;

/** An immutable, sorted run of key→value pairs (a "file"). */
type SSTable = Array<[string, Value]>;

class LSMStore {
  private memtable = new Map<string, Value>();
  private sstables: SSTable[] = []; // newest first
  private readonly flushThreshold: number;

  constructor(flushThreshold = 3) {
    this.flushThreshold = flushThreshold;
  }

  put(key: string, value: string) {
    this.memtable.set(key, value);
    if (this.memtable.size >= this.flushThreshold) this.flush();
  }

  delete(key: string) {
    this.memtable.set(key, TOMBSTONE); // a delete is just a write of a tombstone
    if (this.memtable.size >= this.flushThreshold) this.flush();
  }

  get(key: string): string | undefined {
    // Newest → oldest: memtable, then each SSTable.
    if (this.memtable.has(key)) return this.resolve(this.memtable.get(key)!);
    for (const table of this.sstables) {
      const found = table.find(([k]) => k === key);
      if (found) return this.resolve(found[1]);
    }
    return undefined;
  }

  private resolve(v: Value): string | undefined {
    return v === TOMBSTONE ? undefined : v;
  }

  /** Flush the memtable to a new immutable, sorted SSTable. */
  private flush() {
    const table: SSTable = [...this.memtable.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    this.sstables.unshift(table); // newest first
    log(`   ⇩ flushed memtable → SSTable #${this.sstables.length} (${table.length} entries, sorted)`);
    this.memtable.clear();
  }

  /** Merge all SSTables into one, keeping newest value per key, dropping tombstones. */
  compact() {
    log(`   ⚙ compacting ${this.sstables.length} SSTables...`);
    const merged = new Map<string, Value>();
    // Iterate oldest → newest so newer values overwrite older ones.
    for (const table of [...this.sstables].reverse()) {
      for (const [k, v] of table) merged.set(k, v);
    }
    const live: SSTable = [...merged.entries()]
      .filter(([, v]) => v !== TOMBSTONE) // drop deleted keys entirely
      .sort((a, b) => a[0].localeCompare(b[0]));
    this.sstables = [live];
    log(`   ✓ compacted into 1 SSTable with ${live.length} live keys (tombstones purged)`);
  }

  debug() {
    log(`   state: memtable=${this.memtable.size} entries, ${this.sstables.length} SSTable(s)`);
  }
}

function main() {
  const db = new LSMStore(3); // flush every 3 writes for a visible demo

  log("═══ WRITE PATH: writes land in the memtable, flush when full ═══");
  db.put("user:1", "Alice");
  db.put("user:2", "Bob");
  db.put("user:3", "Carol"); // 3rd write → flush
  db.put("user:1", "Alice v2"); // update: a NEW write, doesn't touch the old SSTable
  db.put("user:4", "Dave");
  db.delete("user:2"); // tombstone → flush

  log("");
  log("═══ READ PATH: newest layer wins ═══");
  db.debug();
  log(`   get user:1 → ${db.get("user:1")}   (newest value, from memtable/newer SSTable)`);
  log(`   get user:2 → ${db.get("user:2") ?? "not found"}   (tombstone shadows the old value)`);
  log(`   get user:3 → ${db.get("user:3")}`);

  log("");
  log("═══ COMPACTION: merge SSTables, keep newest, purge tombstones ═══");
  db.compact();
  db.debug();
  log(`   after compaction, user:1 → ${db.get("user:1")}, user:2 → ${db.get("user:2") ?? "not found"}`);

  log("");
  log("Why this shape: every write was sequential and in-memory-fast; the cost is");
  log("that reads may check several layers and compaction runs forever in the");
  log("background. Great for write-heavy workloads. Phase 3 shows the flip side.");
  process.exit(0);
}

main();
