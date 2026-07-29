/**
 * Phase 5 — DYNAMO-STYLE replication: consistent hashing + hinted handoff +
 * read repair + last-write-wins. Run: npm run phase5
 *
 * This is the "leaderless" model (Dynamo, Cassandra, Riak). No primary — any
 * replica takes writes. Four mechanisms make that survivable, and they're the
 * Staff gate for this topic:
 *
 *   CONSISTENT HASHING — a key hashes onto a ring; its "preference list" is the
 *     next N nodes clockwise. Add/remove a node → only ~1/N of keys move.
 *
 *   HINTED HANDOFF — if a replica in the list is DOWN at write time, a healthy
 *     node accepts the write on its behalf and holds a HINT. When the down node
 *     returns, the hint is delivered. Writes don't fail just because a node blipped.
 *
 *   READ REPAIR — on read, compare replicas; if one is stale, push the newest
 *     value to it during the read. The system heals as a side effect of traffic.
 *
 *   CONFLICT RESOLUTION — concurrent writes to different replicas collide.
 *     Last-write-wins (by timestamp) is simplest but silently drops a write;
 *     vector clocks detect true conflicts so the app can merge. (We show LWW.)
 */

import { log } from "../lib/log.ts";

interface Val { value: string; ts: number }
interface Hint { forNode: string; key: string; val: Val }

class Node {
  up = true;
  data = new Map<string, Val>();
  hints: Hint[] = [];
  id: string;
  constructor(id: string) { this.id = id; }
}

class DynamoRing {
  private nodes: Node[];
  private N: number; // replication factor

  constructor(ids: string[], N: number) {
    this.nodes = ids.map((id) => new Node(id));
    this.N = N;
  }

  private hash(s: string) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /** The preference list: N nodes clockwise from the key's position. */
  private prefList(key: string): Node[] {
    const start = this.hash(key) % this.nodes.length;
    return Array.from({ length: this.N }, (_, i) => this.nodes[(start + i) % this.nodes.length]);
  }

  /** The ids of a key's preference list (for the demo to target). */
  preferenceIds(key: string): string[] { return this.prefList(key).map((n) => n.id); }

  /** A quorum write that reaches only the first W live replicas — leaving the
   *  rest STALE, so read repair has something to heal. */
  writeQuorum(key: string, value: string, ts: number, W: number) {
    const live = this.prefList(key).filter((n) => n.up);
    const targets = live.slice(0, W);
    for (const n of targets) n.data.set(key, { value, ts });
    log(`   WRITE(W=${W}) ${key}="${value}" (ts${ts}) → ${targets.map((n) => n.id).join(", ")} (others now stale)`);
  }

  private nodeById(id: string) { return this.nodes.find((n) => n.id === id)!; }
  setUp(id: string, up: boolean) { this.nodeById(id).up = up; log(`   • node ${id} is now ${up ? "UP" : "DOWN"}`); }

  put(key: string, value: string, ts: number) {
    const pref = this.prefList(key);
    const acked: string[] = [];
    for (const node of pref) {
      if (node.up) {
        node.data.set(key, { value, ts });
        acked.push(node.id);
      } else {
        // Hinted handoff: a healthy node outside the list holds the write.
        const fallback = this.nodes.find((n) => n.up && !pref.includes(n));
        if (fallback) {
          fallback.hints.push({ forNode: node.id, key, val: { value, ts } });
          acked.push(`${fallback.id}(hint→${node.id})`);
        }
      }
    }
    log(`   PUT ${key}="${value}" (ts${ts}) → replicas: ${acked.join(", ")}`);
  }

  /** Read from the preference list, take newest, and REPAIR stale live replicas. */
  get(key: string): Val | undefined {
    const pref = this.prefList(key);
    const live = pref.filter((n) => n.up);
    let newest: Val | undefined;
    for (const n of live) { const v = n.data.get(key); if (v && (!newest || v.ts > newest.ts)) newest = v; }
    if (newest) {
      for (const n of live) {
        const v = n.data.get(key);
        if (!v || v.ts < newest.ts) { n.data.set(key, newest); log(`      ↻ read-repair: healed stale replica ${n.id}`); }
      }
    }
    log(`   GET ${key} → ${newest ? `"${newest.value}" (ts${newest.ts})` : "not found"}`);
    return newest;
  }

  /** A recovered node collects hints other nodes were holding for it. */
  recover(id: string) {
    this.setUp(id, true);
    const node = this.nodeById(id);
    for (const holder of this.nodes) {
      const mine = holder.hints.filter((h) => h.forNode === id);
      for (const h of mine) { node.data.set(h.key, h.val); log(`      ⇄ hint delivered to ${id}: ${h.key}="${h.val.value}"`); }
      holder.hints = holder.hints.filter((h) => h.forNode !== id);
    }
  }
}

function main() {
  const ring = new DynamoRing(["A", "B", "C", "D", "E"], 3);

  // ─── Hinted handoff: take down a node that IS in the key's preference list ─
  const key = "user:1";
  const pref = ring.preferenceIds(key);
  log(`═══ Normal write: ${key}'s preference list is [${pref.join(", ")}] ═══`);
  ring.put(key, "Alice", 1);

  log("");
  log(`═══ Replica ${pref[1]} goes DOWN → hinted handoff keeps the write alive ═══`);
  ring.setUp(pref[1], false);
  ring.put(key, "Alice v2", 2); // pref[1] down → a fallback holds a hint for it

  log("");
  log(`═══ ${pref[1]} recovers → the hint it missed is delivered to it ═══`);
  ring.recover(pref[1]);
  ring.get(key);

  // ─── Read repair: a quorum write leaves one replica stale; a read heals it ─
  log("");
  log("═══ Read repair: a partial (quorum) write leaves a replica stale ═══");
  const k2 = "order:7";
  log(`   ${k2}'s preference list is [${ring.preferenceIds(k2).join(", ")}]`);
  ring.writeQuorum(k2, "pending", 1, 3); // all 3 get v1
  ring.writeQuorum(k2, "shipped", 2, 2); // only 2 of 3 get v2 → 3rd is stale
  ring.get(k2); // read hits all 3, finds newest, repairs the stale one

  // ─── Conflict resolution: last-write-wins drops a concurrent write ─────────
  log("");
  log("═══ Conflict: two concurrent writes, last-write-wins ═══");
  ring.put("cart:9", "add milk", 10);
  ring.put("cart:9", "add eggs", 11); // higher ts wins; 'add milk' is silently dropped
  const c = ring.get("cart:9");
  log(`   LWW kept "${c?.value}" and DROPPED the other concurrent write.`);
  log("   (This is LWW's flaw — a real cart would use vector clocks to detect the");
  log("   conflict and MERGE both items instead of losing one.)");
  process.exit(0);
}

main();
