// 0.8.7: asking Miniflux to fetch when the reader opens or Sync now is pressed. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./helpers.mjs";
const stop = (e) => { for (const t of e._timers) clearTimeout(t); e._timers.clear(); if (e._deferTimer) clearTimeout(e._deferTimer); if (e._batchTimer) clearTimeout(e._batchTimer); };

test("Sync now asks Miniflux to fetch every feed, at most once in fifteen minutes", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); w.mf.st.refreshed = [];
  await e.syncNow(); assert.deepEqual(w.mf.st.refreshed, ["all"]); await e.syncNow(); assert.equal(w.mf.st.refreshed.length, 1, "throttled");
  await e.syncNow({ quiet: true }); assert.equal(w.mf.st.refreshed.length, 1, "quiet polls never ask");
  e.marks.freshAt -= 16 * 60000; await e.syncNow(); assert.equal(w.mf.st.refreshed.length, 2); stop(e);
});

test("when Miniflux limits the request, Pravaha does not ask again for an hour, and syncing is unaffected", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); w.mf.st.refreshed = []; w.mf.st.refreshLimit = true;
  await e.syncNow(); assert.equal(w.mf.st.refreshed.length, 1); assert.equal(e.status().lights.find(l => l.id === "miniflux").state, "green");
  e.marks.freshAt -= 20 * 60000; await e.askFresh(); assert.equal(w.mf.st.refreshed.length, 1, "backed off for an hour"); stop(e);
});

test("the setting turns it off", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); w.mf.st.refreshed = []; await e.saveSettings({ askFresh: false }); await e.syncNow(); assert.equal(w.mf.st.refreshed.length, 0); stop(e);
});
