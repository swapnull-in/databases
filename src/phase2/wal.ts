/**
 * Phase 2 — THE WRITE-AHEAD LOG (WAL) and crash recovery. Run: npm run phase2
 *
 * Phase 1's memtable is in RAM. If the process crashes before the memtable is
 * flushed to an SSTable, those writes are GONE. Every serious database prevents
 * that with a WAL, and the rule is one line:
 *
 *   Before a write is acknowledged, APPEND it to a durable log on disk (and
 *   fsync). Only then update the in-memory state and tell the client "committed".
 *
 * Because the log is append-only, writing to it is sequential (fast). After a
 * crash, you REPLAY the log from the start to rebuild the exact in-memory state.
 * The WAL is the source of truth for durability; the memtable/SSTables are just
 * a fast-to-read materialization of it.
 *
 * fsync is the crux: appendFile puts bytes in the OS page cache, which a power
 * loss can still lose. fsync forces them to the physical disk. "Durable" means
 * "fsync'd". That's also why fsync-per-write is the throughput bottleneck every
 * database fights (group commit, async fsync, etc.).
 *
 * This script writes through a WAL, simulates a crash (throws away the memtable),
 * then recovers a fresh store purely by replaying the log file.
 */

import { openSync, appendFileSync, fsyncSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "../lib/log.ts";

const DATA_DIR = fileURLToPath(new URL("../../data", import.meta.url));
const WAL_PATH = `${DATA_DIR}/wal.log`;

interface WalRecord { op: "put" | "del"; key: string; value?: string }

class DurableStore {
  private memtable = new Map<string, string>();
  private walFd: number;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.walFd = openSync(WAL_PATH, "a"); // append mode
  }

  /** Durable write: WAL first (fsync), THEN memory. */
  put(key: string, value: string) {
    this.appendWal({ op: "put", key, value }); // 1. durable log
    this.memtable.set(key, value);              // 2. in-memory state
  }

  delete(key: string) {
    this.appendWal({ op: "del", key });
    this.memtable.delete(key);
  }

  private appendWal(rec: WalRecord) {
    appendFileSync(this.walFd, JSON.stringify(rec) + "\n");
    fsyncSync(this.walFd); // <-- the durability point: force to disk
  }

  get(key: string) { return this.memtable.get(key); }
  size() { return this.memtable.size; }

  /** Rebuild memtable by replaying the WAL — this is crash recovery. */
  recover() {
    if (!existsSync(WAL_PATH)) return;
    const lines = readFileSync(WAL_PATH, "utf8").split("\n").filter(Boolean);
    let replayed = 0;
    for (const line of lines) {
      const rec: WalRecord = JSON.parse(line);
      if (rec.op === "put") this.memtable.set(rec.key, rec.value!);
      else this.memtable.delete(rec.key);
      replayed++;
    }
    log(`   ⟳ recovered by replaying ${replayed} WAL records`);
  }
}

function main() {
  rmSync(WAL_PATH, { force: true }); // start clean for a reproducible demo

  log("═══ Write through the WAL (each write is fsync'd before ack) ═══");
  const db = new DurableStore();
  db.put("balance:alice", "100");
  db.put("balance:bob", "50");
  db.put("balance:alice", "150"); // update
  db.delete("balance:bob");
  log(`   wrote 4 records. in-memory size = ${db.size()}. WAL is on disk at data/wal.log`);

  log("");
  log("═══ 💥 CRASH: the process dies, the memtable (RAM) is lost ═══");
  // Simulate: forget the object entirely. Its memtable is gone. Only the WAL remains.

  log("");
  log("═══ RESTART: a brand-new store recovers ONLY from the WAL file ═══");
  const recovered = new DurableStore();
  recovered.recover();
  log(`   balance:alice → ${recovered.get("balance:alice")}   (survived the crash ✓)`);
  log(`   balance:bob   → ${recovered.get("balance:bob") ?? "not found"}   (delete replayed ✓)`);

  log("");
  log("The data survived because it was fsync'd to the WAL before we acked it.");
  log("Every engine has this log (Postgres WAL, MySQL redo log, Cassandra commitlog).");
  log("Peek at it:  cat data/wal.log");
  process.exit(0);
}

main();
