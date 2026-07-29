/**
 * Phase 3 — B-TREE vs LSM: the storage-engine tradeoff. Run: npm run phase3
 *
 * Two ways to organize data on disk, two opposite bets:
 *
 *   B-TREE (Postgres, MySQL/InnoDB, most SQL): keeps data sorted in fixed pages
 *     and updates IN PLACE. A read is one top-to-leaf traversal — O(log n),
 *     tight and predictable. A write must find the page and rewrite it (and split
 *     it when full). Reads love B-trees.
 *
 *   LSM (Cassandra, RocksDB): appends writes to an in-memory memtable, flushes
 *     sorted files, merges them later (Phase 1). Writes are cheap sequential
 *     appends. A read may consult several layers. Writes love LSMs.
 *
 * The THREE AMPLIFICATIONS (the vocabulary interviewers want):
 *   • WRITE amplification — bytes written to disk ÷ bytes of actual data. LSM
 *     rewrites the same key many times across compactions. B-tree rewrites a
 *     whole page for a one-row change.
 *   • READ amplification — data read ÷ data you wanted. LSM may probe N SSTables
 *     (mitigated by Bloom filters). B-tree reads one path.
 *   • SPACE amplification — disk used ÷ live data. LSM holds obsolete versions
 *     until compaction; B-trees leave half-full pages (fragmentation).
 *
 * Below: a REAL B-tree and a counting LSM run the same workload; we measure the
 * read cost (nodes/layers touched) and the write cost (disk writes) of each.
 */

import { log } from "../lib/log.ts";

// ─── A real (minimal) B-tree, CLRS-style, with I/O counters ─────────────────
interface BNode { leaf: boolean; keys: string[]; vals: string[]; children: BNode[] }

class BTree {
  private root: BNode = { leaf: true, keys: [], vals: [], children: [] };
  private t: number; // minimum degree (max 2t-1 keys per node)
  nodeWrites = 0;
  nodeReads = 0;

  constructor(t = 3) { this.t = t; }

  get(key: string): string | undefined {
    let node = this.root;
    while (true) {
      this.nodeReads++; // touched a page
      let i = 0;
      while (i < node.keys.length && key > node.keys[i]) i++;
      if (i < node.keys.length && node.keys[i] === key) return node.vals[i];
      if (node.leaf) return undefined;
      node = node.children[i];
    }
  }

  put(key: string, val: string) {
    const r = this.root;
    if (r.keys.length === 2 * this.t - 1) {
      const s: BNode = { leaf: false, keys: [], vals: [], children: [r] };
      this.root = s;
      this.splitChild(s, 0);
      this.insertNonFull(s, key, val);
    } else this.insertNonFull(r, key, val);
  }

  private splitChild(parent: BNode, i: number) {
    const t = this.t;
    const y = parent.children[i];
    const z: BNode = { leaf: y.leaf, keys: y.keys.splice(t), vals: y.vals.splice(t), children: y.leaf ? [] : y.children.splice(t) };
    const midKey = y.keys.pop()!, midVal = y.vals.pop()!;
    parent.keys.splice(i, 0, midKey);
    parent.vals.splice(i, 0, midVal);
    parent.children.splice(i + 1, 0, z);
    this.nodeWrites += 3; // parent, y, z all rewritten
  }

  private insertNonFull(node: BNode, key: string, val: string) {
    let i = node.keys.length - 1;
    if (node.leaf) {
      while (i >= 0 && key < node.keys[i]) i--;
      if (i >= 0 && node.keys[i] === key) { node.vals[i] = val; this.nodeWrites++; return; } // update in place
      node.keys.splice(i + 1, 0, key);
      node.vals.splice(i + 1, 0, val);
      this.nodeWrites++; // rewrote this page
    } else {
      while (i >= 0 && key < node.keys[i]) i--;
      i++;
      if (node.children[i].keys.length === 2 * this.t - 1) {
        this.splitChild(node, i);
        if (key > node.keys[i]) i++;
      }
      this.insertNonFull(node.children[i], key, val);
    }
  }
}

// ─── A counting LSM. `compactEvery` = SSTable count that triggers a merge
//     (Infinity = never compact). This is the knob that trades write-amp for
//     read-amp — the whole point of the demo. ───────────────────────────────
class CountingLSM {
  private memtable = new Map<string, string>();
  private sstables: Array<Map<string, string>> = [];
  diskWrites = 0; // records physically written (appends + compaction rewrites)
  layersRead = 0;
  private threshold: number;
  private compactEvery: number;
  constructor(threshold: number, compactEvery: number) {
    this.threshold = threshold;
    this.compactEvery = compactEvery;
  }

  put(key: string, val: string) {
    this.memtable.set(key, val);
    this.diskWrites++; // one sequential append (cheap)
    if (this.memtable.size >= this.threshold) {
      this.sstables.unshift(new Map(this.memtable));
      this.memtable.clear();
      if (this.sstables.length >= this.compactEvery) this.compact();
    }
  }

  private compact() {
    const merged = new Map<string, string>();
    for (const t of [...this.sstables].reverse()) for (const [k, v] of t) merged.set(k, v);
    this.diskWrites += merged.size; // rewrote every live key — WRITE amplification
    this.sstables = [merged];
  }

  get(key: string): string | undefined {
    this.layersRead++;
    if (this.memtable.has(key)) return this.memtable.get(key);
    for (const t of this.sstables) { this.layersRead++; if (t.has(key)) return t.get(key); } // READ amplification
    return undefined;
  }
  sstableCount() { return this.sstables.length; }
}

function runWrites(store: { put(k: string, v: string): void }, keys: string[], updates: number) {
  for (const k of keys) store.put(k, "v0");
  for (let i = 0; i < updates; i++) store.put(keys[(i * 37) % keys.length], `v${i}`);
}

function main() {
  const N = 500, UPDATES = 500, READS = 500;
  const keys = Array.from({ length: N }, (_, i) => `key:${String(i).padStart(4, "0")}`);
  const readKey = (i: number) => keys[(i * 53) % N];

  // Contestants: a B-tree, an LSM that NEVER compacts, an LSM that compacts hard.
  const btree = new BTree(3);
  const lsmNoCompact = new CountingLSM(32, Infinity);
  const lsmCompact = new CountingLSM(32, 2);

  runWrites(btree, keys, UPDATES);
  runWrites(lsmNoCompact, keys, UPDATES);
  runWrites(lsmCompact, keys, UPDATES);

  btree.nodeReads = 0;
  for (let i = 0; i < READS; i++) { btree.get(readKey(i)); lsmNoCompact.get(readKey(i)); lsmCompact.get(readKey(i)); }

  log(`workload: ${N} inserts + ${UPDATES} updates + ${READS} reads\n`);
  log("                        disk writes    read probes/lookup   SSTables");
  log(`   B-tree               ${pad(btree.nodeWrites)}         ${(btree.nodeReads / READS).toFixed(1)}                 —`);
  log(`   LSM (no compaction)  ${pad(lsmNoCompact.diskWrites)}         ${(lsmNoCompact.layersRead / READS).toFixed(1)}                ${lsmNoCompact.sstableCount()}`);
  log(`   LSM (compact hard)   ${pad(lsmCompact.diskWrites)}         ${(lsmCompact.layersRead / READS).toFixed(1)}                 ${lsmCompact.sstableCount()}`);

  log("");
  log("Read the columns:");
  log(`   • WRITES: the un-compacted LSM is cheapest (${lsmNoCompact.diskWrites} pure appends) — cheaper than the`);
  log(`     B-tree's ${btree.nodeWrites} in-place page writes. Writes love LSM.`);
  log(`   • READS:  that same un-compacted LSM is worst (~${(lsmNoCompact.layersRead / READS).toFixed(0)} SSTable probes/lookup) vs the`);
  log(`     B-tree's steady ~${(btree.nodeReads / READS).toFixed(0)}-node path. Reads love B-trees.`);
  log("   • COMPACTION is the knob: compacting hard slashes read probes but adds");
  log("     write amplification (see its inflated disk-writes). You tune where to sit.");
  log("");
  log("The three amplifications in one table. Real LSMs add Bloom filters so most");
  log("SSTable probes are skipped — pushing read amplification back down toward 1.");
  process.exit(0);
}

const pad = (n: number) => String(n).padStart(5);

main();
