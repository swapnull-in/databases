# Learn Database Internals in TypeScript

A hands-on, runnable project for understanding how databases actually work at a
Staff/EM level — build the storage engine, the write-ahead log, replication,
and transactions from scratch.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly.

> Built to match a Staff-level study path. Every database question is **five
> decisions**: data model · **storage engine (B-tree vs LSM)** · **replication +
> consistency** · **partitioning (the shard key)** · **transactions +
> contention**. This project builds the engine behind decisions 2–5.

## Prerequisites

- **Node.js 22+** (uses native `.ts` execution). No external services needed.

## Setup

```bash
npm install   # only dev types; nothing to download to run the demos
```

## The lessons

Each prints a timestamped log so you can watch the engine work.

| Command | What you learn | Maps to |
|---|---|---|
| `npm run phase1` | **LSM-tree** from scratch — memtable, SSTable flush, tombstones, compaction | storage engine |
| `npm run phase2` | **Write-ahead log** — durability & crash recovery (real file + fsync) | WAL |
| `npm run phase3` | **B-tree vs LSM** — a real B-tree, measured; the three amplifications | engine tradeoff |
| `npm run phase4` | **Quorums** — R + W > N tunable consistency, stale vs fresh reads | replication |
| `npm run phase5` | **Dynamo-style** — consistent hashing, hinted handoff, read repair, LWW | partitioning |
| `npm run phase6` | **Transactions** — MVCC snapshot isolation, lost update, the contention ladder | transactions |

Start by reading `src/phase1/lsm.ts` — the whole storage engine in ~100
commented lines.

## Interactive Storage Lab

Every phase is also a live instrument in the browser — flush an LSM and watch a
tombstone shadow the old value, crash and recover through a WAL, drag the
compaction knob to trade write-amp for read-amp, tune a quorum, heal a Dynamo
ring, and race two transactions.

```bash
npm run web        # serves web/index.html at http://localhost:8080 (no deps)
```

One self-contained static page (self-hosted fonts). To host it on **Cloudflare
Pages**: connect this repo in the dashboard with build output `web` (auto-deploys
on push), or run `npx wrangler login` then `npm run deploy`.

## What each phase proves (the money quotes)

- **Phase 2** — writes survive a simulated crash because they were `fsync`'d to
  the WAL before ack; recovery replays the log. You can `cat data/wal.log`.
- **Phase 3** — one measured table: the un-compacted LSM has the cheapest writes
  (1000) but worst reads (~9 probes/lookup); compacting hard flips it (reads ~2,
  writes balloon to ~12800). **Compaction is the knob** trading write- for read-
  amplification; the B-tree sits in between.
- **Phase 4** — same 3 replicas: `W=1,R=1` reads **stale**, `W=2,R=2` reads
  **fresh**. The single inequality `R+W>N` is the consistency dial.
- **Phase 6** — two concurrent deposits lose an update (final 130 instead of
  180); the compare-and-swap fix makes the loser retry and get 180.

## The five decisions, mapped to phases

| Decision | Where |
|---|---|
| Storage engine (B-tree vs LSM) | Phases 1, 3 |
| Durability (WAL) | Phase 2 |
| Replication + consistency | Phases 4, 5 |
| Partitioning (shard key, ring) | Phase 5 |
| Transactions + contention | Phase 6 |

## Project layout

```
src/
  lib/log.ts                shared timestamped logger
  phase1/  LSM-tree storage engine
  phase2/  write-ahead log + crash recovery
  phase3/  B-tree vs LSM (measured)
  phase4/  quorums (R + W > N)
  phase5/  Dynamo-style replication
  phase6/  MVCC transactions + contention
```

## License

MIT — use it, fork it, learn from it.
