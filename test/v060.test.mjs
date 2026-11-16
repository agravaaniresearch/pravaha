// 0.6.0: the server record and its lamp, the light refresh, feed and folder management, targeted refresh. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { world, entry, feed } from "./helpers.mjs";
import { freshServer, loadServer, parseVersion, versionAtLeast, noteVersion, ackChange, dueForCheck, setCap, badFeed, badEntry, badIds, badVersion, collector, serverLamp, CHECK_EVERY } from "../extension/src/server.js";
import { computeStatus } from "../extension/src/status.js";
import { makeHandlers } from "../extension/src/handlers.js";

const calls = (w, re) => w.mf.st.calls.filter(c => re.test(c));
const quiet = (e) => { for (const t of e._timers) clearTimeout(t); e._timers.clear(); };
// A bigger shelf so that "only what is new" is visible: 12 unread articles across the three feeds.
async function shelf(extra = 12) {
  const w = await world(); const mk = (id, f) => { const e = entry(id, f, `Shelf story ${id}`, "Synthetic text about frigates and budgets.", 5 + id % 7); e.feed = { id: f, title: w.mf.st.feeds.find(x => x.id === f).title, category: w.mf.st.feeds.find(x => x.id === f).category }; return e; };
  for (let i = 0; i < extra; i++) w.mf.st.entries.push(mk(20 + i, 1 + (i % 3)));
  return w;
}

// ---------- the server record: pure functions ----------
test("versions are compared by number, not text, and a missing or odd version is unknown rather than wrong", () => {
  assert.deepEqual(parseVersion("2.3.10"), [2, 3, 10]); assert.deepEqual(parseVersion("v2.4"), [2, 4, 0]); assert.equal(parseVersion("dev"), null); assert.equal(parseVersion(null), null);
  assert.equal(versionAtLeast("2.3.10", "2.3.2"), true, "10 is more than 2"); assert.equal(versionAtLeast("2.2.9", "2.3.2"), false); assert.equal(versionAtLeast("2.3.2", "2.3.2"), true); assert.equal(versionAtLeast("dev", "2.3.2"), null);
});
test("a new version is a change only after one has been seen; the original 'from' survives several updates; Got it clears it; caps are learned again", () => {
  const s = freshServer(); noteVersion(s, "2.2.0", 1000); assert.equal(s.changed, null, "the first sighting is not a change"); assert.equal(s.version, "2.2.0"); assert.equal(s.caps.version, true);
  setCap(s, "entryIds", true); noteVersion(s, "2.2.0", 2000); assert.equal(s.changed, null); assert.equal(s.caps.entryIds, true, "same version keeps what was learned");
  noteVersion(s, "2.3.0", 3000); assert.deepEqual({ from: s.changed.from, to: s.changed.to }, { from: "2.2.0", to: "2.3.0" }); assert.equal(s.caps.entryIds, null, "a different server is learned again");
  noteVersion(s, "2.3.5", 4000); assert.equal(s.changed.from, "2.2.0", "two updates before looking still say where it started"); assert.equal(s.changed.to, "2.3.5");
  ackChange(s); assert.equal(s.changed, null); assert.equal(s.history.length, 3); for (let i = 0; i < 9; i++) noteVersion(s, `3.${i}.0`, 5000 + i); assert.ok(s.history.length <= 5);
  noteVersion(s, null, 9999); assert.equal(s.caps.version, false, "no version answer is recorded, and the old version is kept"); assert.ok(s.version);
});
test("a stored record that is damaged, from a future shape, or missing is made safe", () => {
  assert.deepEqual(loadServer(null), freshServer()); assert.deepEqual(loadServer("junk"), freshServer());
  const s = loadServer({ version: 5, caps: { entryIds: "yes" }, history: [{ v: "2.0.0" }, null, { v: 3 }], changed: { to: 5 }, contract: { problems: "x" } });
  assert.equal(s.version, null); assert.equal(s.changed, null); assert.deepEqual(s.history, [{ v: "2.0.0" }]); assert.ok(Array.isArray(s.contract.problems)); assert.equal(s.caps.afterEntryId, null);
});
test("the version is looked at again after six hours, or at once after a problem, and never while it is fresh", () => {
  const s = freshServer(); assert.equal(dueForCheck(s, 5), true, "never checked"); s.checkedAt = 1000; assert.equal(dueForCheck(s, 1000 + CHECK_EVERY - 1), false); assert.equal(dueForCheck(s, 1000 + CHECK_EVERY + 1), true);
  s.contract.ok = false; assert.equal(dueForCheck(s, 1001), true, "after a contract problem it is looked at on the next refresh");
});
test("setCap only accepts true or false, and only for known names", () => { const s = freshServer(); setCap(s, "entryIds", "maybe"); setCap(s, "nonsense", true); assert.equal(s.caps.entryIds, null); assert.equal(s.caps.nonsense, undefined); setCap(s, "entryIds", false); assert.equal(s.caps.entryIds, false); });
test("the shape checks name the exact missing field and accept what Miniflux really sends", () => {
  assert.equal(badFeed({ id: 1, title: "T", category: { title: "C" } }), null); assert.equal(badFeed({ id: 1, title: "T" }), "category.title"); assert.equal(badFeed({ title: "T", category: { title: "C" } }), "id"); assert.equal(badFeed(null), "feed");
  const e = { id: 4, feed_id: 1, status: "unread", published_at: "2026-11-01T10:00:00Z" };
  assert.equal(badEntry(e), null); assert.equal(badEntry({ ...e, published_at: "yesterday" }), "published_at"); assert.equal(badEntry({ ...e, status: "archived" }), "status"); assert.equal(badEntry({ ...e, feed_id: undefined }), "feed_id"); assert.equal(badEntry({ ...e, title: undefined, content: undefined }), null, "empty title and body are allowed");
  assert.equal(badIds({ total: 2, entry_ids: [1, 2] }), null); assert.equal(badIds({ total: 2 }), "entry_ids"); assert.equal(badIds({ total: 2, entry_ids: [1, "2"] }), "entry_ids"); assert.equal(badIds({ entry_ids: [1] }), "total"); assert.equal(badVersion({ version: "2.3.5" }), null); assert.equal(badVersion({}), "version");
});
test("the collector keeps eight distinct problems at most, counts every skipped item, and a clean pass clears an old problem", () => {
  const s = freshServer(); const c = collector(); for (let i = 0; i < 20; i++) c.note("articles", "f" + (i % 12)); c.note("articles", "f0"); c.done(s, 5);
  assert.equal(s.contract.ok, false); assert.equal(s.contract.problems.length, 8); assert.equal(s.contract.skipped, 21); assert.match(s.contract.problems[0].plain, /an article without a usable "f0"/);
  collector().done(s, 9); assert.deepEqual({ ok: s.contract.ok, n: s.contract.problems.length, skipped: s.contract.skipped }, { ok: true, n: 0, skipped: 0 });
});
test("the lamp: off when not set up, red for a broken contract, amber for an unacknowledged update, green otherwise, and plain about an old server", () => {
  const s = freshServer(); assert.equal(serverLamp(s, false).state, "off"); assert.equal(serverLamp(s, true).state, "off", "configured but never checked");
  noteVersion(s, "2.3.5", 1000); setCap(s, "entryIds", true); let l = serverLamp(s, true, 2000); assert.equal(l.state, "green"); assert.match(l.sentence, /Miniflux 2\.3\.5/);
  noteVersion(s, "2.4.0", 3000); l = serverLamp(s, true, 4000); assert.equal(l.state, "amber"); assert.match(l.sentence, /2\.3\.5 to 2\.4\.0/); assert.match(l.sentence, /Got it/);
  const c = collector(); c.note("articles", "published_at"); c.done(s, 5000); l = serverLamp(s, true, 6000); assert.equal(l.state, "red", "a contract problem beats an update notice"); assert.match(l.sentence, /published_at/); assert.match(l.sentence, /left out/);
  const old = freshServer(); noteVersion(old, "2.1.4", 1); setCap(old, "entryIds", false); const ol = serverLamp(old, true, 2); assert.equal(ol.state, "green"); assert.match(ol.sentence, /older than 2\.3\.2/);
  const hid = freshServer(); noteVersion(hid, null, 1); setCap(hid, "entryIds", false); assert.match(serverLamp(hid, true, 2).sentence, /did not report its version/);
});
test("the server lamp joins the status report and decides the overall light", () => {
  const base = { now: 1e6, device: "a", myHead: 0, remoteHeads: {}, others: {}, miniflux: { configured: true, error: null, lastOkAt: 9e5 }, webdav: { configured: false }, raindrop: { configured: false }, pendingOps: 0, pendingEvents: 0, corruptLines: 0, feeds: { total: 0, dead: 0, trouble: 0 } };
  const s = freshServer(); noteVersion(s, "2.3.5", 1); noteVersion(s, "2.4.0", 2);
  const st = computeStatus({ ...base, serverLamp: serverLamp(s, true, 3) }); assert.ok(st.lights.some(l => l.id === "server" && l.state === "amber")); assert.equal(st.overall, "amber");
  const none = computeStatus({ ...base, miniflux: { configured: false }, serverLamp: serverLamp(s, false, 3) }); assert.equal(none.overall, "off", "nothing set up stays off");
});

// ---------- the light refresh ----------
test("after the first download, a refresh asks for entry numbers and fetches only what is new", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); assert.equal(e.net.miniflux.mode, "full", "an empty cache downloads everything once");
  const have = Object.keys(e.cache.items).length; assert.ok(have >= 16);
  w.mf.st.calls.length = 0; await e.refresh();
  assert.equal(e.net.miniflux.mode, "light"); assert.equal(calls(w, /GET \/entries\/ids/).length >= 1, true); assert.equal(calls(w, /GET \/entries$/).length, 0, "0.8.0: the light pull reconciles by number, so no article body is downloaded on an idle refresh");
  const nw = entry(900, 1, "A brand new story", "Fresh synthetic text.", 0); nw.feed = { id: 1, title: "Naval Wire", category: { title: "Defence/Shipbuilding" } }; w.mf.st.entries.push(nw);
  w.mf.st.calls.length = 0; await e.refresh(); assert.equal(e.cache.items[900].status, "unread"); assert.equal(e.cache.items[900].title, "A brand new story"); assert.equal(calls(w, /GET \/entries$/).length, 1, "one page of new articles and nothing else"); assert.equal(Object.keys(e.cache.items).length, have + 1);
  assert.ok(e.net.miniflux.calls < 14 && e.net.miniflux.bytes > 0, "the call and byte counts are kept for the Sync page");
});
test("a light refresh brings in an article another device marked read, deleted, or turned back to unread, and a star added or removed elsewhere", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); await e.refresh();
  const st = w.mf.st; st.entries.find(x => x.id === 21).status = "read"; st.entries = st.entries.filter(x => x.id !== 22);
  st.entries.find(x => x.id === 1).starred = true; await e.refresh();
  assert.equal(e.net.miniflux.mode, "light"); assert.equal(e.cache.items[21].status, "read", "read elsewhere"); assert.equal(e.cache.items[22].status, "read", "gone from the server, so no longer shown as unread"); assert.equal(e.cache.items[1].starred, true, "starred elsewhere");
  st.entries.find(x => x.id === 21).status = "unread"; st.entries.find(x => x.id === 1).starred = false; await e.refresh(); assert.equal(e.cache.items[21].status, "unread", "turned back to unread elsewhere"); assert.equal(e.cache.items[1].starred, false, "unstarred elsewhere");
});
test("an article just marked read here is not brought back by a light refresh that ran before the server applied it", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); await e.refresh();
  w.mf.st.flaky = { ids: new Set([23]), times: 99 }; await e.markRead([23]); await e.refresh();
  assert.equal(e.cache.items[23].status, "read", "still read here while the server has not stuck"); assert.ok(e.pendingOps.length > 0 || e.cache.recent[23], "and it will be sent again");
});
test("when the server has no list of entry numbers (404), refreshes fall back to the full download, the lamp says so plainly, and the list is not asked for again", async () => {
  const w = await shelf(); w.mf.st.noIds = true; w.mf.st.version = "2.1.4"; const { e } = await w.mk("laptop"); await e.refresh(); await e.refresh();
  assert.equal(e.server.caps.entryIds, false); assert.equal(e.net.miniflux.mode, "full"); assert.equal(calls(w, /entries\/ids/).length, 1, "asked once, then remembered"); assert.ok(Object.keys(e.cache.items).length >= 16);
  const lamp = e.status().lights.find(l => l.id === "server"); assert.equal(lamp.state, "green"); assert.match(lamp.sentence, /older than 2\.3\.2/);
});
test("a malformed list of entry numbers turns the lamp red, names the field, and the refresh still finishes by the full download without losing anything", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); const before = Object.keys(e.cache.items).length; w.mf.st.badIds = true; await e.refresh();
  assert.equal(e.net.miniflux.mode, "full"); assert.equal(Object.keys(e.cache.items).length, before); assert.equal(Object.values(e.cache.items).filter(i => i.status === "unread").length > 0, true, "nothing was wrongly marked read");
  const lamp = e.status().lights.find(l => l.id === "server"); assert.equal(lamp.state, "red"); assert.match(lamp.sentence, /entry numbers/); assert.equal(e.status().overall, "red");
  w.mf.st.badIds = false; e.server.caps.entryIds = null; await e.refresh(); assert.equal(e.status().lights.find(l => l.id === "server").state, "green", "a clean refresh clears the red lamp");
});
test("an incomplete list (more entries than the list holds) is never used to mark anything read", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); const real = w.mf.handler;
  w.mf.handler = async (url, opts) => (new URL(url).pathname.endsWith("/entries/ids") && !new URL(url).searchParams.get("starred") ? new Response(JSON.stringify({ total: 50000, entry_ids: [1] }), { status: 200 }) : real(url, opts));
  const w2 = { ...w }; const unreadBefore = Object.values(e.cache.items).filter(i => i.status === "unread").length; assert.ok(unreadBefore > 5);
  // The engine reaches Miniflux through the fetch function it was given, so route a fresh engine through the wrapped handler.
  const { e: e2 } = await w2.mk("desk"); e2.mf.fetch = async (url, opts) => (new URL(url).pathname.endsWith("/entries/ids") && !new URL(url).searchParams.get("starred") ? new Response(JSON.stringify({ total: 50000, entry_ids: [1] }), { status: 200 }) : real(url, opts));
  await e2.refresh(); await e2.refresh(); assert.equal(e2.net.miniflux.mode, "full"); assert.equal(Object.values(e2.cache.items).filter(i => i.status === "unread").length, unreadBefore, "all the unread articles stayed unread");
});
test("a new Miniflux version turns the lamp amber with both numbers, Got it clears it, and the capabilities are learned again", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); await e.refresh(); assert.equal(e.server.version, "2.3.5"); assert.equal(e.status().lights.find(l => l.id === "server").state, "green");
  w.mf.st.version = "2.4.0"; e.server.checkedAt = 1; await e.refresh(); const l = e.status().lights.find(l => l.id === "server"); assert.equal(l.state, "amber"); assert.match(l.sentence, /2\.3\.5 to 2\.4\.0/); assert.equal(e.status().overall, "amber");
  assert.equal(e.server.caps.entryIds, true, "and it was learned again on that same refresh");
  const st = await e.serverAck(); assert.equal(st.lights.find(x => x.id === "server").state, "green"); assert.equal(e.server.changed, null);
});
test("entries and feeds that do not look right are skipped, counted and named; the good ones are kept", async () => {
  const w = await shelf(); w.mf.st.entries.push({ ...entry(950, 1, "Broken date", "x", 1), published_at: "not a date" }); w.mf.st.feeds.push({ id: 77, title: "No folder", parsing_error_count: 0, disabled: false });
  const { e } = await w.mk("laptop"); await e.refresh();
  assert.equal(e.cache.items[950], undefined, "the broken article was not saved"); assert.ok(e.cache.items[20], "the good ones were"); assert.equal(e.cache.feeds.some(f => f.id === 77), false);
  const l = e.status().lights.find(x => x.id === "server"); assert.equal(l.state, "red"); assert.ok(e.server.contract.problems.some(p => p.field === "published_at") && e.server.contract.problems.some(p => p.field === "category.title"));
  assert.equal(e.server.contract.skipped >= 2, true);
});
test("a bad API key during the version check still says the key is refused, and an unreadable reply is a plain sentence", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop", { miniflux: { url: "https://mf.test", token: "wrong" } }); await e.refresh(); assert.match(e.net.miniflux.error.plain, /refused the API key/);
  const { e: e2 } = await w.mk("desk"); e2.mf.fetch = async () => new Response("<html>maintenance</html>", { status: 200 }); await e2.refresh(); assert.match(e2.net.miniflux.error.plain, /not readable/);
});
test("serverCheck reads only: it reports version, entry numbers, new-article marker and feeds, changes no article, and learns what is missing", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); const before = JSON.stringify(e.cache.items); const r = await e.serverCheck();
  assert.equal(r.ok, true); assert.deepEqual(r.lines.map(l => l.state), ["green", "green", "green", "green", "off"]); assert.equal(JSON.stringify(e.cache.items), before); assert.equal(calls(w, /PUT|DELETE|POST/).length, 0, "no write was made");
  w.mf.st.noIds = true; w.mf.st.noVersion = true; const r2 = await e.serverCheck(); assert.equal(r2.lines[0].state, "amber"); assert.match(r2.lines[1].text, /not offered/); assert.equal(e.server.caps.entryIds, false); assert.equal(e.server.caps.version, false);
  w.mf.st.noIds = false; w.mf.st.noVersion = false; w.mf.st.badIds = true; const r3 = await e.serverCheck(); assert.equal(r3.ok, false); assert.equal(r3.lines[1].state, "red"); assert.equal(e.status().lights.find(l => l.id === "server").state, "red");
});

// ---------- managing feeds ----------
test("renaming a feed changes it on the server, in the list and on its articles; an empty name is refused before any call", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh();
  const none = await e.feedUpdate(2, { title: "   " }); assert.equal(none.ok, false); assert.match(none.sentence, /needs a name/); assert.equal(calls(w, /PUT \/feeds\/2$/).length, 0);
  const r = await e.feedUpdate(2, { title: "  Kitchen   Weekly " }); assert.equal(r.ok, true); assert.match(r.sentence, /“Kitchen Weekly”/);
  assert.equal(w.mf.st.feeds.find(f => f.id === 2).title, "Kitchen Weekly"); assert.equal(e.cache.feeds.find(f => f.id === 2).title, "Kitchen Weekly"); assert.ok(Object.values(e.cache.items).filter(i => i.feedId === 2).every(i => i.feedTitle === "Kitchen Weekly")); assert.ok(e.tree().some(n => n.label === "Kitchen Weekly"));
  const same = await e.feedUpdate(2, { title: "Kitchen Weekly" }); assert.equal(same.unchanged, true); assert.equal(calls(w, /PUT \/feeds\/2$/).length, 1, "no second call for no change");
});
test("moving a feed to an existing folder, and to a folder that does not exist yet, which is created first", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh();
  const r1 = await e.feedUpdate(2, { category: "Defence/Shipbuilding" }); assert.equal(r1.ok, true); assert.equal(e.cache.feeds.find(f => f.id === 2).category, "Defence/Shipbuilding"); assert.equal(calls(w, /POST \/categories/).length, 0);
  const r2 = await e.feedUpdate(2, { category: "Cooking / Weekend" }); assert.equal(r2.ok, true); assert.equal(calls(w, /POST \/categories/).length, 1); assert.equal(e.cache.feeds.find(f => f.id === 2).category, "Cooking/Weekend"); assert.ok(e.tree().some(n => n.id === "cat:Cooking/Weekend"));
  assert.ok(Object.values(e.cache.items).filter(i => i.feedId === 2).every(i => i.category === "Cooking/Weekend"));
});
test("disabling a feed is reversible and takes it out of ranking; a failure leaves everything as it was", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh();
  const r = await e.feedUpdate(2, { disabled: true }); assert.equal(r.ok, true); assert.match(r.sentence, /Disabled/); assert.equal(e.cache.feeds.find(f => f.id === 2).health.dead, true);
  assert.ok(e.getView({ ranked: true }).groups[0].rows.every(x => x.feedId !== 2), "a disabled feed is out of the ranked list");
  const back = await e.feedUpdate(2, { disabled: false }); assert.match(back.sentence, /Enabled/); assert.equal(e.cache.feeds.find(f => f.id === 2).health.dead, false);
  w.ctl.mfDown = true; const down = await e.feedUpdate(2, { title: "Offline name" }); assert.equal(down.ok, false); assert.match(down.sentence, /Could not reach Miniflux/); assert.equal(e.cache.feeds.find(f => f.id === 2).title, "Kitchen Daily", "nothing changed here"); w.ctl.mfDown = false;
  const gone = await e.feedUpdate(9999, { title: "x" }); assert.equal(gone.ok, false); assert.match(gone.sentence, /no longer in the list/);
});
test("deleting a feed needs its exact name, removes it and its articles here, and drops waiting changes for them", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); const mine = Object.values(e.cache.items).filter(i => i.feedId === 3).map(i => i.id); assert.ok(mine.length >= 2);
  e._queue({ op: "status", ids: [mine[0], 1], status: "read" });
  const wrong = await e.feedDelete(3, "broken feed"); assert.equal(wrong.ok, false); assert.match(wrong.sentence, /did not match/); assert.equal(w.mf.st.deleted.length, 0); assert.ok(e.cache.items[mine[0]]);
  const none = await e.feedDelete(3, undefined); assert.equal(none.ok, false);
  const ok = await e.feedDelete(3, "  Broken Feed "); assert.equal(ok.ok, true); assert.match(ok.sentence, new RegExp(`${mine.length} article`)); assert.deepEqual(w.mf.st.deleted, [3]);
  assert.ok(!e.cache.feeds.some(f => f.id === 3)); assert.ok(mine.every(id => !e.cache.items[id] && !e.searchIndex[id])); assert.deepEqual(e.pendingOps.flatMap(o => o.ids || []), [1], "the waiting change for the deleted feed's article is dropped, the other stays");
  assert.ok(!e.tree().some(n => n.id === "feed:3"));
});
test("a folder rename renames the folder and the folders inside it, keeps its place in the order, and moves its articles' folder name", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); await e.setOrder(["cat:Food", "cat:Defence"]); assert.equal(e.tree().filter(n => !n.parent)[0].id, "cat:Food");
  const r = await e.folderRename("Food", "Kitchen"); assert.equal(r.ok, true); assert.deepEqual(r.map, { from: "cat:Food", to: "cat:Kitchen" });
  assert.equal(e.tree().filter(n => !n.parent)[0].id, "cat:Kitchen", "it kept its place"); assert.ok(e.cache.feeds.filter(f => f.id === 2 || f.id === 3).every(f => f.category === "Kitchen"));
  const r2 = await e.folderRename("Defence", "Navy & Army"); assert.equal(r2.ok, true); assert.match(r2.sentence, /Renamed “Defence” to “Navy & Army”\./, "Defence is only the front of a path, so one category was renamed"); assert.ok(e.tree().some(n => n.id === "cat:Navy & Army/Shipbuilding"));
  assert.ok(Object.values(e.cache.items).filter(i => i.feedId === 1).every(i => i.category === "Navy & Army/Shipbuilding"));
  const nested = await e.folderRename("Navy & Army/Shipbuilding", "Yards"); assert.equal(nested.ok, true); assert.ok(e.tree().some(n => n.id === "cat:Navy & Army/Yards")); assert.equal(nested.map.to, "cat:Navy & Army/Yards");
});
test("a folder rename refuses a name already taken, flattens a slash, and says exactly which folders were renamed when one call fails halfway", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh();
  await e.feedUpdate(2, { category: "Cooking" }); await e.feedUpdate(3, { category: "Defence/Reports" });
  const clash = await e.folderRename("Food", "Cooking"); assert.equal(clash.ok, false); assert.match(clash.sentence, /“Cooking” already exists/); assert.equal(calls(w, /PUT \/categories\/\d+$/).length, 0, "the clash was caught before any call");
  const flat = await e.folderRename("Cooking", "Home/Kitchen"); assert.equal(flat.ok, true); assert.ok(e.tree().some(n => n.id === "cat:Home Kitchen"), "a slash would have made a sub-folder, so it became a space");
  w.mf.st.failRename = "Fleet/Reports"; const half = await e.folderRename("Defence", "Fleet"); assert.equal(half.ok, false);
  assert.match(half.sentence, /1 folder was already renamed \(“Fleet\/Shipbuilding”\)/); assert.match(half.sentence, /the rest were left as they were/);
  assert.ok(e.cache.feeds.some(f => f.category === "Fleet/Shipbuilding") && e.cache.feeds.some(f => f.category === "Defence/Reports"), "the list was read again, so the screen shows the half-done state truthfully");
  const gone = await e.folderRename("Nothing", "x"); assert.equal(gone.ok, false); assert.match(gone.sentence, /not found/); assert.equal((await e.folderRename("", "x")).ok, false); assert.equal((await e.folderRename("Home Kitchen", "  ")).ok, false);
});

// ---------- targeted refresh ----------
test("refreshing one feed asks Miniflux for that feed only, then brings in what arrived and says how many", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); await e.refresh();
  w.mf.st.onRefresh = (id) => { const n = entry(970, id, "Arrived after refresh", "Fresh.", 0); n.feed = { id, title: "Naval Wire", category: { title: "Defence/Shipbuilding" } }; w.mf.st.entries.push(n); };
  const r = await e.refreshScope("feed:1"); assert.equal(r.ok, true); assert.match(r.sentence, /“Naval Wire”: 1 new article\./); assert.deepEqual(w.mf.st.refreshed, ["feed:1"]); assert.ok(e.cache.items[970]);
  w.mf.st.onRefresh = null; const again = await e.refreshScope("feed:1"); assert.match(again.sentence, /nothing new/);
  assert.equal((await e.refreshScope("feed:424242")).ok, false);
});
test("refreshing a folder asks for the folder and its sub-folders, then looks again twice; the 429 limit is explained", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh();
  const r = await e.refreshScope("cat:Defence"); assert.equal(r.ok, true); assert.match(r.sentence, /1 feed in “Defence”/); assert.equal(w.mf.st.refreshed.filter(x => x.startsWith("cat:")).length, 1, "'Defence' itself is not a category, only 'Defence/Shipbuilding'"); assert.equal(e._timers.size, 2); assert.equal(e.server.caps.categoryRefresh, true); quiet(e);
  const food = await e.refreshScope("cat:Food"); assert.match(food.sentence, /2 feeds in “Food”/); quiet(e);
  assert.equal((await e.refreshScope("cat:Missing")).ok, false);
  w.mf.st.refreshLimit = true; const lim = await e.refreshScope("feed:1"); assert.equal(lim.ok, false); assert.match(lim.sentence, /limiting how often/); const all = await e.refreshScope("all"); assert.equal(all.ok, false);
  w.mf.st.refreshLimit = false; const ok = await e.refreshScope("all"); assert.equal(ok.ok, true); quiet(e);
});
test("the new messages are wired: each returns the fresh tree, and a rename is shared with Firefox Sync", async () => {
  const w = await shelf(); const { e } = await w.mk("laptop"); await e.refresh(); const pushed = []; const h = makeHandlers({ engine: e, runSync: async () => {}, schedule: async () => {}, openTab: async () => {}, profile: { push: async (parts) => { pushed.push(parts); } } });
  const u = await h.feedUpdate({ id: 2, patch: { title: "Renamed by message" } }); assert.equal(u.ok, true); assert.ok(u.tree.some(n => n.label === "Renamed by message"));
  const f = await h.folderRename({ path: "Food", to: "Eats" }); assert.equal(f.ok, true); assert.deepEqual(pushed.at(-1), ["order"]); assert.ok(f.tree.some(n => n.id === "cat:Eats"));
  const d = await h.feedDelete({ id: 3, confirm: "wrong" }); assert.equal(d.ok, false); assert.ok(Array.isArray(d.tree));
  assert.equal((await h.feedsInfo()).length, 3); assert.ok((await h.feedsInfo()).every(x => typeof x.state === "string" && "errors" in x));
  assert.ok((await h.serverState()).lights.some(l => l.id === "server")); assert.equal((await h.serverCheck()).ok, true); assert.equal((await h.refreshScope({ scope: "feed:1" })).ok, true); assert.ok((await h.serverAck()).lights);
});
