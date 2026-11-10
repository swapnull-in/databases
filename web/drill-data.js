/** Drill data — mined from Core Course/06-databases.md. Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 06 — Databases",
  source: "Core Course/06-databases.md",
  cheats: [
    "Default to <b>Postgres</b>; justify every move off it with a requirement plus a trigger.",
    "<b>Decide, don't enumerate:</b> '<em>choice</em> because <em>requirement</em>; revisit if <em>trigger</em>' — never 'it depends' as a full stop.",
    "<b>Don't shard</b> until replicas + cache + partitioning are exhausted and one node can't hold the writes or data.",
    "<b>B-tree</b> = read-optimized, in-place updates, predictable latency. <b>LSM</b> = write-optimized, append + compaction, jittery p99.",
    "The <b>WAL</b> is written before data pages — sequential-IO durability, and the spine of replication (replication is log shipping).",
    "<b>MVCC garbage</b>: Postgres keeps old versions in the heap (VACUUM, bloat, XID wraparound); InnoDB in the undo log (purge, undo growth). Long transactions hurt both.",
    "<b>Buffer-pool fit vs working set</b> is the #1 OLTP performance predictor — and the quantitative shard trigger.",
    "<b>MySQL/InnoDB</b>: the table is the PK B-tree, so PK choice is load-bearing — use a time-ordered PK (auto-increment, UUIDv7); shard with Vitess.",
    "<b>Cassandra</b>: masterless ring, tunable consistency (<code>R + W > RF</code>, <code>LOCAL_QUORUM</code> multi-region), query-first tables, <em>bounded</em> partitions, TTL + TWCS.",
    "<b>DynamoDB</b>: PK + SK, GSI is eventually consistent, single-table design, and name the hot-partition / write-sharding mitigation unprompted.",
    "Read replicas scale <b>reads, not writes</b> — always pair them with a read-your-writes answer.",
    "<b>Shard key</b> = high cardinality + even distribution + access alignment + no monotonic hotspot. Virtual shards for resharding; keep transactions single-shard.",
    "<b>Leftmost-prefix rule</b>: an index on <code>(a, b, c)</code> serves a / a,b / a,b,c — never b alone. Equality columns first, range columns last.",
    "Indexes <b>tax every write</b> — index for the queries that matter, drop unused ones; non-sargable predicates (functions, casts, leading wildcards) kill index use."
  ],
  cards: [
    {
      topic: "B-tree vs LSM",
      q: "Why is Cassandra write-optimized but read-amplified, and Postgres the opposite?",
      a: "Cassandra uses an <b>LSM-tree</b>: writes append to the commit log and an in-memory memtable, then flush as immutable sorted SSTables — purely sequential IO, no random page updates. Reads must check the memtable plus potentially many SSTables (mitigated by Bloom filters), and compaction rewrites data repeatedly, so reads and writes are amplified. Postgres uses a <b>B-tree</b> with in-place page updates: a read is one O(log n) path, but a write may dirty a full page through the WAL. The choice is a bet on read:write ratio — LSM when writes dominate and you tolerate compaction p99 jitter, B-tree when you need predictable read latency."
    },
    {
      topic: "MVCC",
      q: "How does MVCC differ between Postgres and InnoDB, and what breaks at scale?",
      a: "Both keep multiple row versions so readers never block writers — but the <b>garbage lives in different places</b>. Postgres writes new versions into the heap and reclaims dead tuples via VACUUM; its failure modes are table <b>bloat</b> and <b>XID wraparound</b>. InnoDB keeps old versions in the <b>undo log</b>, reclaimed by the purge thread; its failure mode is undo/history-list growth from long transactions. In both, the root cause is almost always an idle-in-transaction session pinning old versions — set <code>idle_in_transaction_session_timeout</code> on any write-heavy Postgres."
    },
    {
      topic: "replication lag",
      q: "You add read replicas. A user updates their profile and immediately sees the old value. What happened and how do you fix it?",
      a: "Replication is asynchronous, so the immediate read hit a replica that hadn't replayed the WAL yet — a <b>read-your-writes</b> violation. Cheapest reliable fix: route the user's reads to the <b>primary for a short window after they write</b> (sticky-to-primary). Alternatives: pin the session to one replica (monotonic reads) or track the write's log position and wait for catch-up (causal); semi-sync replication bounds lag but taxes write latency. Be explicit that replicas scale reads only — writes still bottleneck on the primary, which is what sharding is for."
    },
    {
      topic: "shard key",
      q: "How would you pick a shard key for a multi-tenant SaaS, and how do you avoid the pitfalls?",
      a: "Shard by <code>tenant_id</code> so each tenant's data co-locates — most queries and transactions stay single-shard, avoiding cross-shard joins and 2PC. Check cardinality and distribution, and plan for the <b>whale tenant</b>: sub-shard it on a secondary dimension or isolate it on its own shard. Use hash plus a <b>fixed number of virtual shards</b> (say 1024) so growth moves whole vshards instead of rehashing everything. Never range-shard on time or auto-increment — that's a monotonic hotspot."
    },
    {
      topic: "DynamoDB GSI",
      q: "Why are DynamoDB GSIs eventually consistent, and what is the hot-partition problem?",
      a: "A GSI is a <b>global, term-partitioned index</b>: it's sharded by a different partition key than the base table, so a write must also update an index entry on another partition — done asynchronously, hence eventual consistency. The hot-partition problem: throughput is per-partition, so one celebrity key caps you even when the table is under-utilized overall. Mitigate with <b>write sharding</b> (suffix the key with a shard number, scatter-gather on read), a higher-cardinality key, and adaptive capacity. Design the write-sharding before the celebrity arrives, not after."
    },
    {
      topic: "SQL vs NoSQL",
      q: "SQL or NoSQL for a new product — how do you decide?",
      a: "Drive from <b>access patterns and constraints</b>, not dogma, and default to Postgres. Relationships, joins, transactions, and exploratory queries favor SQL; known key-based access beyond single-node write volume, aggregate-shaped data, or a zero-ops mandate favor NoSQL. Real systems are <b>polyglot</b>: a relational system of record plus specialized stores per proven access pattern — and you must name the source of truth. 'NoSQL because scale' without a write-volume number is a junior tell."
    },
    {
      topic: "1B users",
      q: "Design the data layer for a system with 1 billion users.",
      a: "<b>Estimate → cache → replicate → shard → async → tier.</b> Do the math first (~2 TB of profiles, ~50–100K peak read QPS) so you attack the binding constraint — usually reads. Cache the hot set in Redis, add read replicas with read-your-writes routing, and only when writes or data exceed one node, shard by <code>user_id</code> over virtual shards so per-user queries stay single-shard. Push analytics and fan-out to queues via CDC, and tier cold data to object storage so the hot index stays in RAM. Cheapest lever first; sharding is the last resort."
    },
    {
      topic: "leftmost prefix",
      q: "I have an index on (a, b, c) but my query WHERE b = 5 doesn't use it. Why?",
      a: "The <b>leftmost-prefix rule</b>: the index is sorted by <code>a</code> first, so it can seek on a, (a,b), or (a,b,c) — a predicate on <code>b</code> alone has no contiguous range to seek. Fix: lead the index with <code>b</code> if that's the common query, or add a separate index on <code>(b, ...)</code>. Also check the predicate is <b>sargable</b> — a function or cast on the column disables the index too. Confirm with <code>EXPLAIN ANALYZE</code> rather than guessing."
    },
    {
      topic: "distributed SQL",
      q: "When would you choose distributed SQL (Spanner/CockroachDB) over sharded Postgres?",
      a: "Only when you genuinely need <b>horizontal write scale AND cross-shard ACID AND strong multi-region consistency</b> — and don't want to hand-build sharding. Distributed SQL auto-shards, replicates each shard via Raft/Paxos, and provides cross-shard transactions: Spanner orders them globally with <b>TrueTime</b> (GPS + atomic clocks), Cockroach and Yugabyte approximate it with hybrid logical clocks. The cost is cross-region transaction latency (consensus plus commit-wait) and a younger ecosystem. For most companies, Postgres plus replicas plus eventual Vitess-style sharding is enough — never reach for it by default."
    },
    {
      topic: "partition vs shard",
      q: "What's the difference between partitioning and sharding, and which do you reach for first?",
      a: "<b>Partitioning</b> splits one table into pieces within a single node (e.g., Postgres range-partition events by month) — better manageability, query pruning, instant old-data drops, but no new machines. <b>Sharding</b> distributes data across nodes to scale writes and storage, and brings routers, cross-shard joins, and resharding pain. Reach for partitioning first, alongside indexes, caching, and replicas — many 'we need to scale' problems end there. Shard only when a single node can't hold the write volume or data size."
    },
    {
      topic: "altitude",
      q: "The interviewer says 'just design the database schema for X' — how do you avoid the rabbit hole?",
      a: "Name-and-move-on the unremarkable fields in one sentence ('standard user table — id, name, email, timestamps, nothing load-bearing'), then pivot to where the design actually lives: <b>access patterns, the shard/partition key, hot-partition risk, and the consistency boundary</b>. The columns aren't the design; the access patterns and the key are. Catching yourself debating VARCHAR(255) vs TEXT is the signal you've dropped altitude — pull back up to decisions with blast radius."
    },
    {
      topic: "committing",
      q: "You're asked to choose a database and you genuinely could justify two. What do you say?",
      a: "Never stop at 'it depends'. State the <b>axis the decision turns on</b>, resolve it with the requirement in front of you, and commit: '<em>choice</em> because <em>requirement</em>; I'd revisit toward <em>alternative</em> if <em>trigger</em>'. Example: 'Postgres because the access patterns are relational and exploratory and we're nowhere near single-node write limits; revisit toward Cassandra if sustained write TPS pushes past one node and the data is append-shaped.' Committing with a named trigger shows judgment; enumerating without choosing shows none."
    },
    {
      topic: "change data capture",
      q: "Your app writes Postgres and then the search index. Retries are in place. Why can the index still end up permanently wrong?",
      a: "Because retries fix <b>partial failure</b>, not <b>ordering</b>. Two writers can commit A then B in the database while their index writes arrive B then A. Both writes succeeded, nothing retried, and the index now holds A forever. The fix is to stop writing twice: read the database's own log (<b>change data capture</b>), which is the one ordered record of every commit, and feed the index from that. It also covers write paths that never knew about the index, such as a batch job or an admin script."
    },
    {
      topic: "change data capture",
      q: "A CDC connector restarts and replays an hour of events the consumer already applied. What keeps the target correct, and what is the operational risk on the source?",
      a: "Delivery is <b>at-least-once</b>, so the consumer applies each event as a <b>version-guarded upsert</b>: write only if the event's log position (LSN) is newer than the one stored for that key, so duplicates and stale replays are no-ops (Elasticsearch calls this external versioning). The risk on the source is <b>retained log</b>: Postgres keeps WAL for a replication slot until the connector confirms it, so a connector that is down for a weekend can fill the primary's disk. Alert on slot lag and cap it with <code>max_slot_wal_keep_size</code>. And use CDC for copies; when consumers need the reason for a change, write an <b>outbox</b> row in the same transaction instead."
    },
    {
      topic: "auction bidding",
      q: "Two users bid on the same auction at the same instant. How do you make sure neither bid is lost and exactly one outcome is correct?",
      a: "Never read-then-decide in application memory: both bidders read the same row, and the second write erases the first (a <b>lost update</b>). Make <b>the write carry the check</b>: update the auction row only if it is still at the version you read (or <code>WHERE status = 'open' AND :max > high_max</code>), and append the bid to the log in the <b>same transaction</b>, so state and history cannot diverge. The loser re-reads and retries. With proxy bidding the protected state is the <b>top two maximums</b>; the visible price is the second maximum plus one increment, capped at the leader's maximum."
    },
    {
      topic: "auction bidding",
      q: "An auction ends at 8:00:00 and the close job runs at 8:00:30. A bid arrives at 8:00:10. Does it count, and what if 300 bids arrive in the last second?",
      a: "It does not count. Validity is <b>received_at &lt; end_time</b>, stamped by the server's clock at the API, and that rule is checked on every bid, so it does not depend on when the close job runs. The close itself is a <b>fenced</b> <code>open → closed</code> conditional write, so a job that fires twice closes once. For the last-second burst, optimistic retries thrash: each round one write wins and the rest retry, roughly N² work. <b>Serialize</b> a hot auction through one ordered writer, such as a log partition keyed by auction ID, which applies bids in order with no conflicts. Throughput per auction is then far above human bidding rates."
    }
  ]
};
