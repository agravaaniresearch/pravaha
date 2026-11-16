import test from "node:test";
import assert from "node:assert/strict";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { world, ids } from "./helpers.mjs";


test("sync pulls feeds and unread, builds the nested tree and groups by feed", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const t = e.tree(); const labels = t.map(n => `${n.depth}:${n.label}`);
  assert.ok(labels.includes("0:Defence") && labels.includes("1:Shipbuilding") && labels.includes("2:Naval Wire"));
  assert.equal(t.find(n => n.label === "Defence").unread, 2, "folder count includes nested feeds");
  const v = e.getView({}); assert.deepEqual(v.groups.map(g => g.title).sort(), ["Broken Feed", "Kitchen Daily", "Naval Wire"]);
  assert.equal(v.unreadTotal, 4); assert.equal(e.getView({ scope: "cat:Defence" }).total, 2); assert.equal(e.getView({ scope: "feed:2" }).total, 1);
});
test("ranking: the navy story beats the cake recipe, dead feeds are left out of the ranked view", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const v = e.getView({ ranked: true }); const order = ids(v);
  assert.ok(order.indexOf(1) < order.indexOf(2), "relevant item first"); assert.ok(!order.includes(3), "dead feed excluded");
  const r = v.groups[0].rows[0]; assert.ok(r.score > 0 && r.score <= 1); assert.ok(r.why.length > 3);
});
test("search and Unread/All modes", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  assert.deepEqual(ids(e.getView({ q: "lemon" })), [2]);
  await e.markRead([2]); assert.equal(ids(e.getView({ mode: "unread" })).includes(2), false); assert.equal(ids(e.getView({ mode: "unread", keep: [2] })).includes(2), true); assert.equal(ids(e.getView({ mode: "all" })).includes(2), true);
});
test("marking read offline is instant, queued, shown amber, and flushed later", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  w.ctl.mfDown = true; await e.markRead([1, 2]);
  assert.equal(e.cache.items[1].status, "read"); assert.equal(e.pendingOps.length, 1);
  const st = e.status(); assert.equal(st.lights.find(l => l.id === "miniflux").state, "red"); assert.equal(st.left.ops, 2);
  await e.syncNow(); assert.equal(e.cache.items[1].status, "read", "a failed refresh must not undo the local read");
  w.ctl.mfDown = false; await e.syncNow();
  assert.equal(w.mf.st.entries.find(x => x.id === 1).status, "read"); assert.equal(e.pendingOps.length, 0); assert.equal(e.status().lights.find(l => l.id === "miniflux").state, "green");
});
test("a refresh does not overwrite a read still waiting to reach the server", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  w.ctl.mfDown = true; await e.markRead([2]); w.ctl.mfDown = false;
  e.pendingOps = [{ op: "status", ids: [2], status: "read" }]; // keep it queued while a refresh runs against the stale server copy
  const orig = e.flushOps; e.flushOps = async () => {}; await e.refresh(); e.flushOps = orig;
  assert.equal(e.cache.items[2].status, "read");
});
test("open marks read, logs the event and raises the feed's standing; dismiss hides and lowers it; undo restores", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const before = e.stats().league.find(f => f.id === 1).authority;
  const r = await e.open(1); assert.equal(r.url, "https://site1.example/1"); assert.equal(e.cache.items[1].status, "read");
  await e.recordDwell(1, 1, 40000); assert.ok(e.stats().league.find(f => f.id === 1).authority > before); assert.equal(e.stats().opens, 1);
  await e.dismiss(2); assert.equal(ids(e.getView({ mode: "all" })).includes(2), false); assert.equal(e.getView({}).dismissedCount, 1);
  await e.undismissAll(); assert.equal(ids(e.getView({ mode: "all" })).includes(2), true);
  await e.recordDwell(1, 1, 400); assert.equal(e.stats().dwellMinutes, 1 - 1 + Math.round(40000 / 60000));
});
test("save toggles the Miniflux star, saves one way to Raindrop with local tag suggestions, and unsave reverses the star", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.saveSettings({ saveToRaindrop: true }); await e.syncNow();
  const r = await e.toggleSave(1); assert.equal(r.saved, true); assert.equal(w.mf.st.entries.find(x => x.id === 1).starred, true);
  await new Promise(r => setTimeout(r, 20)); assert.equal(w.rd.st.saved.length, 1); assert.ok(w.rd.st.saved[0].tags.length > 0, "tags suggested from your own vocabulary");
  assert.equal(e.getView({ scope: "saved" }).total, 1);
  await e.toggleSave(1); assert.equal(w.mf.st.entries.find(x => x.id === 1).starred, false); assert.equal(e.getView({ scope: "saved" }).total, 0);
});
test("training rules change the ranking and can be removed", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const s0 = e.getView({ ranked: true }).groups[0].rows.find(r => r.id === 2).score;
  await e.train("feed", 2, 1); const s1 = e.getView({ ranked: true }).groups[0].rows.find(r => r.id === 2).score; assert.ok(s1 > s0);
  await e.train("feed", 2, 0); assert.equal(e.getView({ ranked: true }).groups[0].rows.find(r => r.id === 2).score, s0); assert.deepEqual(e.trainingRules(), []);
});
test("two machines: dismissals, saves and training made on one appear on the other, and status goes green on both", async () => {
  const w = await world(); const A = (await w.mk("laptop")).e, B = (await w.mk("desktop")).e;
  await A.syncNow(); await B.syncNow();
  await A.dismiss(2); await A.train("feed", 1, 1); await A.open(1); await A.syncNow();
  await B.syncNow(); await A.syncNow();
  assert.equal(ids(B.getView({ mode: "all" })).includes(2), false); assert.deepEqual(B.trainingRules(), [{ type: "feed", key: "1", value: 1 }]);
  assert.equal(B.stats().opens, 1);
  for (const m of [A, B]) { const s = m.status(); assert.equal(s.overall, "green", JSON.stringify(s.lights)); assert.equal(s.left.events, 0); }
  assert.equal(JSON.stringify(A.log.list().map(e => e.eid)), JSON.stringify(B.log.list().map(e => e.eid)));
});
test("two machines give the same score for the same item once they hold the same inputs", async () => {
  const w = await world(); const A = (await w.mk("laptop")).e, B = (await w.mk("desktop")).e;
  await A.syncNow(); await B.syncNow(); await A.open(1); await A.train("keyword", "naval", 1); await A.syncNow(); await B.syncNow(); await A.syncNow();
  A.settings.novelty = false; B.settings.novelty = false; A.sessionFeeds = new Set([1, 2, 3]); B.sessionFeeds = new Set([1, 2, 3]); A._invalidate(); B._invalidate();
  const sa = A.getView({ ranked: true }).groups[0].rows.map(r => [r.id, r.score]), sb = B.getView({ ranked: true }).groups[0].rows.map(r => [r.id, r.score]);
  for (const [id, s] of sa) { const o = sb.find(x => x[0] === id)[1]; assert.ok(Math.abs(s - o) < 0.03, `item ${id}: ${s} vs ${o}`); }
  assert.deepEqual(sa.map(x => x[0]), sb.map(x => x[0]), "same order on both machines");
});
test("WebDAV down: changes stay local, light is red, then everything lands after recovery", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  w.ctl.davDown = true; await e.open(1); await e.syncNow();
  const s = e.status(); assert.equal(s.lights.find(l => l.id === "webdav").state, "red"); assert.ok(s.left.events > 0); assert.match(s.lights.find(l => l.id === "log").sentence, /safe here/);
  w.ctl.davDown = false; await e.syncNow(); assert.equal(e.status().left.events, 0); assert.equal(e.status().overall, "green");
});
test("bad Miniflux key gives a plain sentence and keeps the cached view", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  await e.saveSettings({ miniflux: { token: "wrong" } }); await e.syncNow();
  const l = e.status().lights.find(x => x.id === "miniflux"); assert.equal(l.state, "red"); assert.match(l.sentence, /refused the API key/); assert.ok(e.getView({}).total > 0);
});
test("state survives a restart", async () => {
  const w = await world(); const { e, storage } = await w.mk("laptop"); await e.syncNow(); await e.open(1); await e.train("feed", 2, -1);
  const e2 = new Engine({ storage, fetchImpl: w.fetchImpl }); await e2.load();
  assert.equal(e2.stats().opens, 1); assert.deepEqual(e2.trainingRules(), [{ type: "feed", key: "2", value: -1 }]); assert.ok(e2.getView({}).total > 0);
});
test("digest and enrichment files are written to WebDAV; external scores are blended in", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const d = await e.writeDigest(); assert.ok(w.dav.files.has(`pravaha/digests/${d.week}.md`)); assert.match(d.md, /pravaha-digest/);
  const outbox = JSON.parse(w.dav.files.get("pravaha/enrich/outbox.json")); assert.equal(outbox.version, 1);
  const base = e.getView({ ranked: true }).groups[0].rows.find(r => r.id === 2).score;
  w.dav.files.set("pravaha/enrich/results.json", JSON.stringify({ version: 1, results: [{ id: 2, score: 1, flag: "serendipity" }] }));
  e.marks.outboxAt = 0; // an hour later: the outside-scoring files are read at most hourly from 0.8.0
  await e.syncNow(); const row = e.getView({ ranked: true }).groups[0].rows.find(r => r.id === 2); assert.ok(row.score > base); assert.equal(row.flag, "serendipity");
});
test("renaming the machine keeps history and starts a fresh sync position", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); await e.open(1);
  await e.saveSettings({ device: "laptop-2" }); assert.equal(e.stats().opens, 1); await e.syncNow(); assert.equal(e.status().left.events, 0);
});
test("retention drops old read articles but keeps saved and opened ones", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  for (const id of [2, 4]) { e.cache.items[id].status = "read"; e.cache.items[id].publishedAt = Date.now() - 90 * 86400000; }
  e.cache.items[4].starred = true; e._retain(); assert.equal(!!e.cache.items[2], false); assert.equal(!!e.cache.items[4], true);
});
test("regression: a read made while another flush is in flight is not lost, and ops are never sent twice", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const p1 = e.open(1); const p2 = e.markRead([2]); const p3 = e.markRead([4]); await Promise.all([p1, p2, p3]); await e.flushOps();
  for (const id of [1, 2, 4]) assert.equal(w.mf.st.entries.find(x => x.id === id).status, "read", `entry ${id}`);
  assert.equal(e.pendingOps.length, 0);
  const puts = w.mf.st.calls.filter(c => c === "PUT /entries").length; assert.ok(puts <= 3);
});
test("pending ops reloaded after a restart are never marked in flight", async () => {
  const w = await world(); const { e, storage } = await w.mk("laptop"); await e.syncNow(); w.ctl.mfDown = true; await e.markRead([2]);
  const raw = await storage.get(["pendingOps"]); raw.pendingOps[0].inflight = true; await storage.set(raw);
  const e2 = new Engine({ storage, fetchImpl: w.fetchImpl }); await e2.load(); assert.equal(e2.pendingOps[0].inflight, false);
});
