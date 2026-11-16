// 0.8.1: Raindrop "MiniFlux Saves" as a relevance signal, Pravaha's own Raindrop save off by default, extension health. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./helpers.mjs";
import { healthSummary, freshHealth, noteWrite, notePoll, HOUR } from "../extension/src/health.js";

const quiet = (e) => { for (const t of e._timers) clearTimeout(t); e._timers.clear(); if (e._deferTimer) { clearTimeout(e._deferTimer); e._deferTimer = null; } };
const withColl = async (links) => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); quiet(e);
  w.rd.st.collections = [{ _id: 1, title: "Geopolitics" }]; w.rd.st.children = [{ _id: 77, title: "MiniFlux Saves" }];
  for (const [i, link] of links.entries()) w.rd.st.bookmarks.push({ _id: 900 + i, title: "saved by Miniflux", excerpt: "", note: "", tags: ["auto"], link, collection: { $id: 77 }, lastUpdate: new Date().toISOString() });
  await e.refreshRaindrop(true); quiet(e); return { w, e };
};

test("an article Miniflux saved to the \"MiniFlux Saves\" collection counts as a save for ranking, without a logged event", async () => {
  const w0 = await world(); const url = w0.mf.st.entries.find(x => x.id === 2).url;
  const { e } = await withColl([url, "https://not-in-miniflux.example/x"]);
  assert.equal(e.raindropCache.mfColl.title, "MiniFlux Saves");
  const d = e._derive(); const feed = String(e.cache.items[2].feedId);
  assert.ok(d.standing[feed].engaged > 0, "the feed's standing counts it"); assert.ok(d.pulls.some(p => p.kind === "save"), "the profile is pulled");
  assert.ok(!e.log.list().some(x => x.type === "save"), "nothing is written to the history, so nothing new travels between machines");
  const lamp = e.status().lights.find(l => l.id === "raindrop"); assert.match(lamp.sentence, /Found "MiniFlux Saves": 1 of its 2 saves/);
});

test("an article saved both in Pravaha and by Miniflux counts once", async () => {
  const w0 = await world(); const url = w0.mf.st.entries.find(x => x.id === 2).url;
  const { e } = await withColl([url]); await e.toggleSave(2); quiet(e); e._derived = null;
  const feed = String(e.cache.items[2].feedId); const one = e._derive().standing[feed].engaged;
  e.raindropCache.mfColl = null; e._derived = null; const without = e._derive().standing[feed].engaged;
  assert.ok(Math.abs(one - without) < 1e-9, "the Raindrop copy adds nothing on top of your own save");
});

test("Pravaha's own one-way Raindrop save is off after the update, and can be turned back on", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  assert.equal(e.settings.saveToRaindrop, false); await e.toggleSave(1); quiet(e); await new Promise(r => setTimeout(r, 20)); assert.equal(w.rd.st.saved.length, 0);
  await e.saveSettings({ saveToRaindrop: true }); await e.load(); assert.equal(e.settings.saveToRaindrop, true, "the switch-off happens once only");
});

test("health: an idle poll is recorded as light, with its requests and no large write", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); await e.syncNow({ quiet: true }); quiet(e);
  const hl = e.status().health; assert.equal(hl.state, "green"); assert.equal(hl.last.heavy, false); assert.ok(hl.last.reqs >= 1 && hl.last.reqs <= 8); assert.match(hl.sentence, /^Running light/);
});

test("health thresholds: amber past 1 MB an hour or when a quiet poll that found nothing rewrote a large key, red past 10 MB an hour", () => {
  const now = 10 * HOUR; let h = freshHealth(); noteWrite(h, now - 1000, 2048, false); assert.equal(healthSummary(h, now).state, "green");
  noteWrite(h, now - 500, 2 * 1048576, true); assert.equal(healthSummary(h, now).state, "amber");
  noteWrite(h, now - 400, 9 * 1048576, true); assert.equal(healthSummary(h, now).state, "red");
  assert.equal(healthSummary(h, now + 2 * HOUR).state, "green", "an hour later the writes have aged out of the window");
  h = freshHealth(); notePoll(h, { at: now, ms: 40, reqs: 3, bytes: 900000, heavy: true, changed: false }); assert.equal(healthSummary(h, now).state, "amber"); assert.match(healthSummary(h, now).sentence, /nothing had changed/);
});

test("0.8.1 fix: an engine built without a fetch function (as the background builds it) uses the browser's own fetch", async () => {
  const { Engine, MemoryStorage } = await import("../extension/src/engine.js"); const w = await world(); const real = globalThis.fetch; let called = 0;
  globalThis.fetch = (...a) => { called++; return w.fetchImpl(...a); };
  try {
    const storage = new MemoryStorage(); await storage.set({ settings: { device: "bg", miniflux: { url: "https://mf.test", token: "good-key" }, webdav: { url: "https://dav.test", user: "u", pass: "p", root: "pravaha" }, raindrop: { token: "rd-token" } } });
    const e = new Engine({ storage }); await e.load(); await e.syncNow(); quiet(e);
    assert.ok(called > 0); assert.equal(e.status().lights.find(l => l.id === "miniflux").state, "green"); assert.equal(e.status().lights.find(l => l.id === "webdav").state, "green");
  } finally { globalThis.fetch = real; }
});

test("0.8.1 fix: reading ten articles in a row writes the article copy once, not ten times", async () => {
  const { Engine, MemoryStorage } = await import("../extension/src/engine.js"); const w = await world(); let heavy = 0;
  class S extends MemoryStorage { async set(o) { if ("cache" in o) heavy++; return super.set(o); } }
  const storage = new S(); await storage.set({ settings: { device: "a", miniflux: { url: "https://mf.test", token: "good-key" } } });
  const e = new Engine({ storage, fetchImpl: w.fetchImpl }); await e.load(); await e.syncNow(); quiet(e); heavy = 0;
  for (const id of [1, 2, 3, 4]) { await e.openCard(id); await e.markUnread([id]); await e.openCard(id); } quiet(e);
  assert.equal(heavy, 0, "nothing heavy during the burst"); await e.flushPersist(); assert.equal(heavy, 1, "one write when the delay ends, the poll comes or the page unloads");
});
