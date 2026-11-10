# Study Guide — Database Internals in TypeScript

This repo is the runnable half of **[Core Course/06-databases.md](https://github.com/swapnull-in/system-design/blob/main/Core%20Course/06-databases.md)**: every claim the module makes about storage engines, replication, sharding, and transactions is a phase you can execute and watch. Study loop: read a module section, run the matching phase (`npm run phaseN`), read its ~100-line source top-to-bottom, then drill yourself with the web Drill panel (`npm run web`). The phase logs are your recall anchors — if you can predict a phase's output before running it, you own that section.

## Phase-to-module mapping

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| 1 | LSM-tree from scratch — memtable, SSTable flush, tombstones, compaction | 1.1 B-Tree vs LSM-Tree | "LSM converts random writes into sequential IO and Bloom-filtered reads; we accept read and compaction amplification in exchange for ingest throughput" |
| 2 | Write-ahead log — real file, fsync, crash recovery by replay | 1.2 Write-Ahead Log & Durability | "The WAL isn't just durability — it's the *spine* of replication... replication is log shipping" |
| 3 | A real B-tree vs the LSM, with the three amplifications measured | 1.1 (amplification table) | "The B-Tree vs LSM choice is really a bet on your read:write ratio and your latency-vs-throughput priority" |
| 4 | Quorum replication — R + W > N, stale vs fresh reads | 3.2 Cassandra (tunable consistency) | "`R + W > RF` guarantees strong consistency... `LOCAL_QUORUM` keeps it within one datacenter" |
| 5 | Dynamo-style ring — consistent hashing, hinted handoff, read repair, LWW | 3.2 Cassandra · 4.2 Multi-Leader | "LWW... simple, but silently loses data and is sensitive to clock skew" |
| 6 | MVCC snapshot isolation, the lost update, compare-and-swap retry | 1.3 MVCC: Postgres vs InnoDB | "Long-running read transactions are the enemy because they pin old versions" |
| 7 | Seq vs index scan, composite/leftmost-prefix, covering index, N+1 vs IN | 5. Indexes & Query Optimization | "Indexes aren't free — each one taxes every write and the buffer pool, so I index for the queries that matter" |
| 8 | Hash/range/consistent/virtual-shard remap costs; hot-partition write-sharding | 4.3 Sharding Strategies | "A fixed number of logical/virtual shards from day one so resharding moves whole shards instead of rehashing everything" |
| 9 | The anomaly ladder — dirty read, non-repeatable, phantom, write skew | 1.3 (isolation pitfalls) | "If you propose `SERIALIZABLE`, you must also propose the retry loop" |
| 10 | Buffer pool — pages, LRU, hit ratio vs pool size, the scan cliff | 1.4 Pages & Buffer Pool | "'Is the working set in memory?' is the single most predictive question for OLTP database performance" |
| 12 | Change data capture — dual-write race vs tailing the WAL, lsn-guarded upserts, replay, slot lag | Deep Dive 39 · 1.2 Write-Ahead Log | "Never dual-write a derived store. The database already has one ordered log of every commit; CDC just reads it." |

## Go deeper

- **[Deep Dives/03-postgresql.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/03-postgresql.md)** — heap MVCC, VACUUM/XID wraparound, and the extension ecosystem behind "Postgres until proven otherwise" (phases 6, 9, 10).
- **[Deep Dives/04-cassandra.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/04-cassandra.md)** — the ring, query-first tables, bounded partitions, and TTL + TWCS in production (phases 1, 4, 5).
- **[Deep Dives/05-dynamodb.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/05-dynamodb.md)** — partition physics, GSI vs LSI, single-table design, and write-sharding the hot key (phases 5, 8).
- **[Deep Dives/34-newsql-distributed-sql.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/34-newsql-distributed-sql.md)** — Spanner TrueTime vs HLC, and when distributed SQL beats sharded Postgres (after phase 8).
- **[Deep Dives/24-banking-ledger.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/24-banking-ledger.md)** — transactions and isolation with real money on the line; the payoff of phases 6 and 9.
- **[Deep Dives/39-change-data-capture.md](https://github.com/swapnull-in/system-design/blob/main/Deep%20Dives/39-change-data-capture.md)** — Debezium and Kafka, snapshots, ordering and delivery guarantees, the replication-slot outage, and CDC vs the outbox (phase 12).
- **DDIA** — 04-storage-and-retrieval (phases 1–3, 10), 06-replication (phases 4–5), 07-sharding (phase 8), 08-transactions (phases 6, 9).
