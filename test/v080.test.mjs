// 0.8.0: running light. Deadlines on every request, writes only what changed, quieter polls, the reworked relevance engine. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { world, entry, feed } from "./helpers.mjs";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { Miniflux } from "../extension/src/miniflux.js";
import { EventLog, Clock } from "../extension/src/eventlog.js";
import { tokenize } from "../extension/src/text.js";

const quiet = (e) => { for (const t of e._timers) clearTimeout(t); e._timers.clear(); if (e._deferTimer) { clearTimeout(e._deferTimer); e._deferTimer = null; } };
class CountingStorage extends MemoryStorage {
  constructor() { super(); this.log = []; }
  async set(o) { this.log.push(Object.keys(o)); return super.set(o); }
}
const ready = async () => {
  const w = await world(); const storage = new CountingStorage(); await storage.set({ settings: { device: "laptop", miniflux: { url: "https://mf.test", token: "good-key" }, webdav: { url: "https://dav.test", user: "u", pass: "p", root: "pravaha" }, raindrop: { token: "rd-token" }, retentionDays: 30 } });
  const e = new Engine({ storage, fetchImpl: w.fetchImpl, platform: { echoDocs: async () => [{ title: "Navy frigate shipyard news", url: "https://navalnews.example/x", visits: 5 }] } });
  await e.load(); await e.syncNow(); quiet(e); storage.log.length = 0; return { w, e, storage };
};

test("a Miniflux request that never answers is abandoned with a plain sentence, so the sync lock is released", async () => {
  const hang = (url, opts) => new Promise((_, rej) => { opts.signal && opts.signal.addEventListener("abort", () => rej(opts.signal.reason || new DOMException("t", "TimeoutError"))); });
  const mf = new Miniflux({ baseUrl: "https://mf.test", token: "k", fetchImpl: hang }); mf.timeoutMs = 60;
  const keep = setTimeout(() => {}, 5000); // Node does not hold the process open for AbortSignal.timeout alone; Firefox has no such issue
  const t0 = Date.now(); await assert.rejects(mf.me(), (e) => e.code === "timeout" && /did not answer in time/.test(e.plain)); assert.ok(Date.now() - t0 < 2000); clearTimeout(keep);
});

test("an idle poll writes no heavy key at all: the article copy, history and index are written only when they change", async () => {
  const { e, storage } = await ready();
  await e.syncNow({ quiet: true }); quiet(e);
  const heavy = storage.log.flat().filter(k => ["cache", "events", "searchIndex"].includes(k));
  assert.deepEqual(heavy, [], "nothing heavy on a poll that found nothing new");
});

test("opening an article writes the small keys at once and the history tail, so a crash before the delayed write loses nothing", async () => {
  const { w, e, storage } = await ready();
  await e.open(1); quiet(e);
  const first = storage.log.flat(); assert.ok(first.includes("pendingOps") && first.includes("eventsTail"), "small keys and the tail at once"); assert.ok(!first.includes("cache") && !first.includes("events"), "the heavy keys wait");
  const e2 = new Engine({ storage, fetchImpl: w.fetchImpl }); await e2.load();
  assert.ok(e2.log.list().some(x => x.type === "open" && x.entry === 1), "the open survives a restart before the delayed write");
  await e.flushPersist(); const e3 = new Engine({ storage, fetchImpl: w.fetchImpl }); await e3.load(); assert.equal(e3.log.list().filter(x => x.type === "open").length, 1, "no double after the full write");
});

test("an idle poll costs a handful of requests: the feed list every fifteen minutes, no article bodies, no folder making, no state rewrite", async () => {
  const { w, e } = await ready(); const calls = []; const base = e.fetchImpl;
  const spy = async (u, o) => { calls.push(`${(o && o.method) || "GET"} ${new URL(u).host}${new URL(u).pathname}`); return base(u, o); };
  e.fetchImpl = spy; e._wire(); e.syncer.state = e.syncState; await e.syncNow({ quiet: true }); quiet(e);
  assert.ok(!calls.some(c => /\/v1\/feeds$/.test(c)), "the feed list is not read again within fifteen minutes");
  assert.ok(!calls.some(c => /GET mf\.test\/v1\/entries$/.test(c)), "no article bodies on an idle light refresh");
  assert.ok(!calls.some(c => c.startsWith("MKCOL")), "the folders are known to exist");
  assert.ok(!calls.some(c => c.startsWith("PUT dav.test")), "nothing changed, so nothing is uploaded");
  assert.ok(calls.length <= 8, `requests: ${calls.join(", ")}`);
  e.marks.feedsAt = 0; calls.length = 0; await e.syncNow({ quiet: true }); quiet(e); assert.ok(calls.some(c => /\/v1\/feeds$/.test(c)), "and read again once it is due");
});

test("an article from a feed this machine does not know yet brings the feed list in at once", async () => {
  const { w, e } = await ready();
  w.mf.st.feeds.push(feed(9, "New Wire", "Defence")); const n = entry(77, 9, "Fresh frigate story", "naval", 0); n.feed = { id: 9, title: "New Wire", category: { title: "Defence" } }; w.mf.st.entries.push(n);
  await e.syncNow({ quiet: true }); quiet(e); assert.ok(e.cache.feeds.some(f => f.id === 9)); assert.ok(e.tree().some(x => x.id === "feed:9"));
});

test("a second machine that has pushed nothing new is not downloaded again", async () => {
  const w = await world(); const a = await w.mk("laptop"); const b = await w.mk("desktop");
  await a.e.syncNow(); await a.e.open(1); await a.e.syncNow(); await b.e.syncNow(); quiet(a.e); quiet(b.e);
  assert.ok(b.e.log.list().some(x => x.device === "laptop" && x.type === "open"));
  const gets = []; const base = w.fetchImpl; b.e.fetchImpl = async (u, o) => { if ((o.method || "GET") === "GET" && /events\/laptop\//.test(u)) gets.push(u); return base(u, o); }; b.e._wire(); b.e.syncer.state = b.e.syncState; b.e.syncer._listed = true;
  await b.e.syncNow({ quiet: true }); quiet(b.e); assert.equal(gets.length, 0, "the state file said there was nothing new");
  await a.e.open(2); await a.e.syncNow(); quiet(a.e); await b.e.syncNow({ quiet: true }); quiet(b.e);
  assert.ok(gets.length >= 1 && b.e.log.list().some(x => x.device === "laptop" && x.entry === 2), "and fetched as soon as there was");
});

test("feed standing is an engagement rate: a firehose with many articles and the same opens ranks below a small feed you read fully", async () => {
  const w = await world(); const now = Date.now();
  w.mf.st.feeds.push(feed(5, "Firehose", "News"), feed(6, "Boutique", "News"));
  for (let i = 0; i < 60; i++) { const x = entry(500 + i, 5, `Firehose item ${i}`, "general news", 30 + (i % 20)); x.feed = { id: 5, title: "Firehose", category: { title: "News" } }; w.mf.st.entries.push(x); }
  for (let i = 0; i < 3; i++) { const x = entry(600 + i, 6, `Boutique essay ${i}`, "long essay", 30 + i); x.feed = { id: 6, title: "Boutique", category: { title: "News" } }; w.mf.st.entries.push(x); }
  const { e } = await w.mk("laptop"); await e.syncNow(); quiet(e);
  assert.ok(e.log.list().some(x => x.type === "calibration" && x.payload.kind === "exposure"), "yesterday's article counts are logged once");
  const before = e.log.list().filter(x => x.type === "calibration").length; await e.syncNow(); quiet(e); assert.equal(e.log.list().filter(x => x.type === "calibration").length, before, "and not again the same day");
  for (const id of [500, 501, 502, 600, 601, 602]) await e.open(id); quiet(e);
  const st = e._derive().standing; assert.ok(st["6"].value > st["5"].value, `boutique ${st["6"].value.toFixed(2)} above firehose ${st["5"].value.toFixed(2)}`);
  assert.ok(Number.isFinite(e.scoreRow(1).score));
});

test("the same story from two feeds is hot; the reason says so", async () => {
  const w = await world(); w.mf.st.feeds.push(feed(7, "Second Wire", "Defence"));
  const x = entry(70, 7, "Navy orders new frigates from shipyard in record deal", "The defence ministry procurement of warship frigates continues at the shipyard.", 2); x.feed = { id: 7, title: "Second Wire", category: { title: "Defence" } }; w.mf.st.entries.push(x);
  const { e } = await w.mk("laptop"); await e.syncNow(); quiet(e);
  const r = e.scoreRow(70); assert.ok(r.breakdown.hotOthers >= 1, "covered by another feed"); assert.match(r.why, /also covered by 1 other feed/);
  assert.equal(e.scoreRow(2).breakdown.hotOthers, 0, "a lone story is not hot");
});

test("a clock a year ahead on another machine is not adopted, so decay does not freeze for everyone", () => {
  let t = 1_700_000_000_000; const c = new Clock("a", () => t); const log = new EventLog("a", c);
  log.merge([{ v: 1, eid: "b:1", device: "b", ts: `${String(t + 365 * 86400000).padStart(14, "0")}.00000.b`, type: "open", entry: 1, feed: 1 }]);
  const mine = log.append("open", { entry: 2, feed: 1 }); assert.ok(Number(mine.ts.slice(0, 14)) < t + 2 * 86400000);
});

test("designators survive tokenising and entities are not words", () => {
  const t = tokenize("India weighs F-35 and S-400 &rsquo;deals&rsquo; with the U.S. &mdash; MQ-9B too");
  for (const w of ["f35", "s400", "mq9b", "usa"]) assert.ok(t.includes(w), w); for (const junk of ["rsquo", "mdash"]) assert.ok(!t.includes(junk), junk);
});

test("a feed icon Miniflux refuses is not asked for again on every poll", async () => {
  const { w, e } = await ready(); e.cache.feeds[0].iconId = 99; delete e.icons[e.cache.feeds[0].id];
  const base = w.fetchImpl; let asked = 0; e.fetchImpl = async (u, o) => { if (/\/icon$/.test(u)) { asked++; return new Response(JSON.stringify({ error_message: "not found" }), { status: 404 }); } return base(u, o); }; e._wire();
  await e.refreshIcons(); await e.refreshIcons(); assert.equal(asked, 1);
});

test("a WebDAV folder deleted behind Pravaha's back is made again in the same sync, without a red light", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); quiet(e);
  for (const k of [...w.dav.files.keys()]) w.dav.files.delete(k); w.dav.dirs.clear(); w.dav.dirs.add("");
  const base = w.dav.handler; w.dav.handler = async (u, o) => { if (o.method === "PUT") { const p = decodeURIComponent(new URL(u).pathname).replace(/^\/+/, ""); const dir = p.split("/").slice(0, -1).join("/"); if (!w.dav.dirs.has(dir)) return new Response("", { status: 409 }); } return base(u, o); };
  await e.open(1); await e.syncNow(); quiet(e);
  assert.equal(e.status().lights.find(l => l.id === "webdav").state, "green"); assert.ok([...w.dav.files.keys()].some(k => k.startsWith("pravaha/events/laptop/")));
});
