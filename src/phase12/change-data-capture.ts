/**
 * Phase 12 — CHANGE DATA CAPTURE: keep a second copy in sync by reading the log.
 * Run: node src/phase12/change-data-capture.ts
 *
 * The problem in one line: the database is the truth, and something else needs
 * a copy — a search index, a cache, a warehouse. The tempting design is the
 * DUAL WRITE: the app writes the database, then writes the index. It fails in
 * two ways that retries cannot fix:
 *
 *   • PARTIAL FAILURE — the DB commit succeeds, the index write fails or the
 *     app crashes in between. Nothing remembers that the index is now stale.
 *   • THE ORDERING RACE — two writers commit A then B in the database, but
 *     their index writes land B then A. Both writes "succeeded"; the index is
 *     wrong FOREVER, and nothing will ever correct it.
 *
 * The fix is to stop writing twice. The database already keeps one ordered
 * record of every commit — the write-ahead log (phase2). CHANGE DATA CAPTURE
 * reads that log like a replica would and turns each commit into an event:
 *
 *   change(lsn, key, op, after)        lsn = log sequence number, strictly increasing
 *
 * Three properties fall out of "the log is the source of changes":
 *
 *   • EVERY WRITE PATH IS COVERED — a batch job or an admin script that never
 *     heard of the index still appears in the log.
 *   • PER-KEY ORDER IS THE COMMIT ORDER — the race above cannot happen.
 *   • DELIVERY IS AT-LEAST-ONCE — a connector that restarts replays events it
 *     already sent. So the consumer must be idempotent, and the standard move
 *     is the VERSION-GUARDED UPSERT: apply an event only if its lsn is newer
 *     than the lsn already stored for that key. Duplicates and stale replays
 *     become no-ops. (Elasticsearch calls this external versioning.)
 *
 * The operational price: the database must KEEP the log until the connector
 * has read it. In Postgres that is a replication slot, and a connector that
 * is down for a weekend makes the primary retain WAL until its disk fills.
 * Slot lag is a paging alert, not a dashboard curiosity.
 *
 * We demo: (A) the dual-write ordering race, reproduced deterministically;
 * (B) the same two writes through CDC — the index converges; (C) a connector
 * restart that replays old events — the version guard drops them; (D) a write
 * path that forgot the index — CDC catches it anyway; (E) retained log growing
 * while the connector is down.
 *
 * TAKEAWAY: never dual-write a derived store. Read the database's own log,
 * key the events by primary key, and make every apply a version-guarded
 * upsert. CDC is for COPIES; when a consumer needs to know WHY a row changed
 * (send the email when the order ships), write an outbox row in the same
 * transaction and capture that instead (distributed-systems, phase 10).
 */

import { log } from "../lib/log.ts";

// ── The source database: a table plus its write-ahead log ────────────────────

interface Change {
  lsn: number;                 // position in the log; commit order
  key: string;
  op: "upsert" | "delete";
  after: number | null;        // the row's new value (a price), null on delete
}

class Database {
  readonly table = new Map<string, number>();
  readonly wal: Change[] = [];
  private nextLsn = 1;

  /** One commit: the table changes and the log records it, atomically. */
  write(key: string, value: number): Change {
    this.table.set(key, value);
    const change: Change = { lsn: this.nextLsn++, key, op: "upsert", after: value };
    this.wal.push(change);
    return change;
  }

  delete(key: string): Change {
    this.table.delete(key);
    const change: Change = { lsn: this.nextLsn++, key, op: "delete", after: null };
    this.wal.push(change);
    return change;
  }
}

// ── The derived store: a search index that remembers the lsn it applied ──────

interface IndexedDoc {
  value: number;
  lsn: number;                 // source position this doc reflects (0 = unversioned)
}

class SearchIndex {
  readonly docs = new Map<string, IndexedDoc>();
  private readonly deletedAt = new Map<string, number>(); // tombstones, so a replayed upsert can't resurrect a row

  /** A dual write has no version to check: the last write to arrive wins. */
  blindPut(key: string, value: number): void {
    this.docs.set(key, { value, lsn: 0 });
  }

  /** Apply a change only if it is newer than what we already hold for the key. */
  applyChange(change: Change): "applied" | "skipped" {
    const seen = Math.max(this.docs.get(change.key)?.lsn ?? 0, this.deletedAt.get(change.key) ?? 0);
    if (change.lsn <= seen) return "skipped";
    if (change.op === "delete") {
      this.docs.delete(change.key);
      this.deletedAt.set(change.key, change.lsn);
    } else {
      this.docs.set(change.key, { value: change.after!, lsn: change.lsn });
    }
    return "applied";
  }
}

// ── The connector: tails the log from a remembered position ──────────────────

class Connector {
  /** Last lsn the connector has durably confirmed — the replication slot's position. */
  confirmedLsn = 0;
  private readonly db: Database;
  private readonly index: SearchIndex;

  constructor(db: Database, index: SearchIndex) {
    this.db = db;
    this.index = index;
  }

  /** Read everything after `fromLsn` and apply it. Returns applied/skipped counts. */
  drain(fromLsn = this.confirmedLsn): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    for (const change of this.db.wal) {
      if (change.lsn <= fromLsn) continue;
      if (this.index.applyChange(change) === "applied") applied++;
      else skipped++;
      this.confirmedLsn = Math.max(this.confirmedLsn, change.lsn);
    }
    return { applied, skipped };
  }

  /** Log the database must keep because this connector has not read it yet. */
  retained(): number {
    return this.db.wal.filter((c) => c.lsn > this.confirmedLsn).length;
  }
}

function show(db: Database, index: SearchIndex, key: string): string {
  const inDb = db.table.get(key);
  const inIndex = index.docs.get(key)?.value;
  const verdict = inDb === inIndex ? "✅ in sync" : "❌ DIVERGED";
  return `db=${inDb ?? "∅"}  index=${inIndex ?? "∅"}  ${verdict}`;
}

// ── (A) The dual-write race ──────────────────────────────────────────────────

log("(A) DUAL WRITE — two writers update product:42, then each writes the index");
{
  const db = new Database();
  const index = new SearchIndex();
  db.write("product:42", 100);
  index.blindPut("product:42", 100);

  // Writer A and writer B commit to the database in the order A, B…
  db.write("product:42", 79);   // A
  db.write("product:42", 85);   // B — the database's final answer is 85
  // …but their index writes cross on the network and land B, then A.
  index.blindPut("product:42", 85); // B's index write arrives first
  index.blindPut("product:42", 79); // A's arrives last and wins

  log("   db commit order: A(79) then B(85)   index arrival order: B(85) then A(79)");
  log("   " + show(db, index, "product:42"));
  log("   both writes succeeded, nothing failed, and nothing will ever repair the index");
}

// ── (B) The same writes through CDC ──────────────────────────────────────────

log("");
log("(B) CDC — the same two writes, but the index is fed from the log");
const db = new Database();
const index = new SearchIndex();
const connector = new Connector(db, index);
db.write("product:42", 100);
db.write("product:42", 79);    // A
db.write("product:42", 85);    // B
{
  const { applied } = connector.drain();
  log(`   connector applied ${applied} changes in lsn order (1 → 2 → 3)`);
  log("   " + show(db, index, "product:42"));
}

// ── (C) At-least-once: a restart replays old events ──────────────────────────

log("");
log("(C) CONNECTOR RESTART — it lost its position and replays the log from the start");
{
  const before = index.docs.get("product:42")!;
  const { applied, skipped } = connector.drain(0); // replay everything
  const after = index.docs.get("product:42")!;
  log(`   replayed ${applied + skipped} events: ${applied} applied, ${skipped} skipped by the version guard`);
  log(`   index before=${before.value}@lsn${before.lsn}  after=${after.value}@lsn${after.lsn}  (unchanged)`);
  log("   without the guard, replaying lsn 2 (79) over lsn 3 (85) would have moved the index BACKWARDS");
}

// ── (D) A write path that never heard of the index ───────────────────────────

log("");
log("(D) A FORGOTTEN WRITE PATH — a nightly script updates and deletes rows directly");
{
  db.write("product:7", 250);     // script inserts a row; no index code anywhere
  db.write("product:42", 60);     // …and reprices another
  db.delete("product:7");         // …then removes the first
  const { applied } = connector.drain();
  log(`   connector applied ${applied} changes the script never sent`);
  log("   product:42  " + show(db, index, "product:42"));
  log("   product:7   " + show(db, index, "product:7") + "  (the delete propagated too)");
}

// ── (E) The operational hazard: retained log ─────────────────────────────────

log("");
log("(E) CONNECTOR DOWN — the database must keep log the connector has not read");
{
  for (let i = 0; i < 5000; i++) db.write(`product:${i % 50}`, 100 + i);
  log(`   connector confirmed up to lsn ${connector.confirmedLsn}; database is at lsn ${db.wal.length}`);
  log(`   retained log: ${connector.retained()} changes and growing — in Postgres this is WAL held by a`);
  log("   replication slot, and it fills the primary's disk. Alert on slot lag; cap it (max_slot_wal_keep_size).");
  const { applied } = connector.drain();
  log(`   connector back: applied ${applied}, retained log now ${connector.retained()}`);
  const diverged = [...db.table.keys()].filter((k) => db.table.get(k) !== index.docs.get(k)?.value).length;
  log(`   rows out of sync after catch-up: ${diverged}`);
}

log("");
log("TAKEAWAY: one ordered log, read once, applied with a version guard. CDC for copies; outbox for intent.");
