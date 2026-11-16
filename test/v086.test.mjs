// 0.8.6: read changes are held and sent to Miniflux together. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./helpers.mjs";

const puts = (w) => w.mf.st.calls.filter(x => x === "PUT /entries").length;
const ready = async () => { const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); e.batchMs = 30000; w.mf.st.calls.length = 0; return { w, e }; };
const stop = (e) => { if (e._batchTimer) clearTimeout(e._batchTimer); e._batchTimer = null; for (const t of e._timers) clearTimeout(t); e._timers.clear(); if (e._deferTimer) clearTimeout(e._deferTimer); };

test("reading several articles in a row sends nothing at once, then one request with all of them", async () => {
  const { w, e } = await ready();
  await e.openCard(1); await e.openCard(2); await e.markRead([3]); await e.dismiss(4);
  assert.equal(puts(w), 0, "nothing sent while reading"); assert.equal(e.cache.items[3].status, "read", "the screen changes at once");
  const lamp = e.status().lights.find(l => l.id === "miniflux"); assert.equal(lamp.state, "green"); assert.match(lamp.sentence, /4 read changes are saved here and will reach Miniflux together/);
  await e.sendHeld(); assert.equal(puts(w), 1, "one request for all four"); assert.equal(e._remaining(), 0);
  for (const id of [1, 2, 3, 4]) assert.equal(w.mf.st.entries.find(x => x.id === id).status, "read"); stop(e);
});

test("held changes survive a restart and go out with the next poll", async () => {
  const { w, e } = await ready(); await e.openCard(1); await e.openCard(2); stop(e);
  const { Engine } = await import("../extension/src/engine.js"); const e2 = new Engine({ storage: e.storage, fetchImpl: w.fetchImpl }); await e2.load();
  assert.equal(e2._remaining(), 2, "still waiting after the restart"); await e2.syncNow(); assert.equal(e2._remaining(), 0);
  assert.equal(w.mf.st.entries.find(x => x.id === 2).status, "read"); stop(e2);
});

test("a save still goes at once, and takes the held reads with it", async () => {
  const { w, e } = await ready(); await e.openCard(1); await e.toggleSave(2);
  assert.ok(w.mf.st.calls.some(x => /PUT \/entries\/2\/(bookmark|star)/.test(x)), "the star reached Miniflux"); assert.equal(e._remaining(), 0, "the held read went with it"); stop(e);
});

test("a large mark-as-read that is checked with Miniflux is not held", async () => {
  const { w, e } = await ready(); const ids = Object.keys(e.cache.items).map(Number); await e.markRead(ids, { explicit: true, verify: true });
  assert.ok(puts(w) >= 1); assert.equal(e._remaining(), 0); stop(e);
});
