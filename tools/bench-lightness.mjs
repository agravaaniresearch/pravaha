// Lightness benchmark on synthetic data: what one idle poll and one card open cost.
// Usage: node tools/bench-lightness.mjs [--json]
// Synthetic library: 200 feeds, 3,000 unread articles, 4,400 Raindrop saves, 2,000 history events.
// Numbers are from headless Node against in-memory fakes. They show the size of a change, not the speed of a real machine.
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeDav, makeMiniflux, makeRaindrop, router, feed, entry, settings } from "../test/helpers.mjs";

const WORDS = "navy frigate shipyard budget deficit monsoon rupee export tariff oncology trial radiation tumour brain glioma policy treaty border drone missile satellite semiconductor fab energy ammonia hydrogen grid coal solar port corridor rail freight election court ruling inflation bank credit".split(" ");
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");

class CountingStorage extends MemoryStorage {
  constructor() { super(); this.bytes = 0; this.writes = 0; }
  async set(o) { this.writes++; for (const k of Object.keys(o)) this.bytes += JSON.stringify(o[k]).length; return super.set(o); }
}

export async function bench() {
  const dav = makeDav(), mf = makeMiniflux();
  const rd = makeRaindrop({ bookmarks: Array.from({ length: 4400 }, (_, i) => ({ _id: i, title: words(8), excerpt: words(20), note: i % 10 ? "" : words(10), tags: [WORDS[i % WORDS.length], WORDS[(i * 7) % WORDS.length]], link: `https://saved${i % 300}.example/${i}`, lastUpdate: new Date(Date.now() - (i % 700) * 86400000).toISOString() })) });
  mf.st.feeds = Array.from({ length: 200 }, (_, i) => feed(i + 1, `Feed ${i + 1}`, ["Defence", "Economy", "Medicine/Oncology", "Energy", "Geopolitics/Asia"][i % 5]));
  mf.st.entries = Array.from({ length: 3000 }, (_, i) => { const f = (i % 200) + 1; const e = entry(i + 1, f, words(9), words(220), (i % 240) / 2); e.feed = { id: f, title: `Feed ${f}`, category: mf.st.feeds[f - 1].category }; return e; });
  const net = { calls: 0, bytes: 0, byHost: {} };
  const base = router({ dav, mf, rd });
  const fetchImpl = async (url, opts = {}) => {
    const r = await base(url, opts); const host = new URL(url).host; const t = await r.clone().text(); const up = opts.body ? String(opts.body).length : 0;
    net.calls++; net.bytes += t.length + up; const h = (net.byHost[host] ||= { calls: 0, down: 0, up: 0 }); h.calls++; h.down += t.length; h.up += up; return r;
  };
  const storage = new CountingStorage(); await storage.set({ settings: settings("bench-a") });
  const e = new Engine({ storage, fetchImpl, platform: { echoDocs: async () => Array.from({ length: 1500 }, (_, i) => ({ title: words(7), url: `https://hist${i % 200}.example/${i}`, visits: 1 + (i % 9) })) } });
  await e.load();
  for (let i = 0; i < 2000; i++) { const id = (i % 3000) + 1; e.log.append(i % 3 ? "card" : "open", { entry: id, feed: ((id - 1) % 200) + 1, payload: { terms: words(12).split(" "), score: 0.3 } }); }
  await e.persist(["events"]);
  await e.syncNow({ quiet: true }); // first sync: everything downloads
  const zero = () => { net.calls = 0; net.bytes = 0; net.byHost = {}; storage.bytes = 0; storage.writes = 0; };

  // A fresh event page: the background was unloaded and wakes for the alarm.
  const wake = async () => { const x = new Engine({ storage, fetchImpl, platform: e.platform }); const t = performance.now(); await x.load(); return { x, loadMs: performance.now() - t }; };
  zero(); let { x, loadMs } = await wake(); let t = performance.now(); await x.syncNow({ quiet: true });
  const idleWake = { ms: Math.round(performance.now() - t + loadMs), calls: net.calls, kb: Math.round(net.bytes / 1024), byHost: net.byHost, storageWrites: storage.writes, storageKB: Math.round(storage.bytes / 1024) };
  zero(); t = performance.now(); await x.syncNow({ quiet: true });
  const idleWarm = { ms: Math.round(performance.now() - t), calls: net.calls, kb: Math.round(net.bytes / 1024), byHost: net.byHost, storageWrites: storage.writes, storageKB: Math.round(storage.bytes / 1024) };

  x._invalidate(); t = performance.now(); x._buildModel(); const modelMs = Math.round(performance.now() - t);
  t = performance.now(); const v = x.getView({ scope: "all", mode: "unread" }); const viewMs = Math.round(performance.now() - t);
  t = performance.now(); x.getView({ scope: "all", mode: "unread" }); const viewWarmMs = Math.round(performance.now() - t);
  const first = v.groups[0].rows[0].id;
  zero(); t = performance.now(); await x.openCard(first); x.getView({ scope: "all", mode: "unread" }); const cardMs = Math.round(performance.now() - t);
  const card = { ms: cardMs, storageWrites: storage.writes, storageKB: Math.round(storage.bytes / 1024) };
  if (x.flushPersist) await x.flushPersist();
  return { idleWake, idleWarm, modelMs, viewMs, viewWarmMs, card, rows: v.total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await bench();
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    const line = (n, o) => console.log(`${n.padEnd(28)} ${String(o.ms).padStart(6)} ms  ${String(o.calls ?? "").padStart(4)} calls  ${String(o.kb ?? "").padStart(6)} KB net  ${String(o.storageWrites).padStart(3)} writes  ${String(o.storageKB).padStart(6)} KB written`);
    line("Idle poll after a wake", r.idleWake); line("Idle poll, page awake", r.idleWarm); line("Open a card and redraw", r.card);
    console.log(`Model build ${r.modelMs} ms, list of ${r.rows} rows ${r.viewMs} ms (again ${r.viewWarmMs} ms)`);
    console.log("Network by host after a wake:", JSON.stringify(r.idleWake.byHost));
  }
}
