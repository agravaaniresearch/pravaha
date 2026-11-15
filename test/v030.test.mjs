// 0.3.0: reliable bulk mark-read, local search, folder order, feed discovery and the activity report.
import test from "node:test";
import assert from "node:assert/strict";
import { entry } from "./helpers.mjs";
import { world } from "./helpers.mjs";
import { PlainError } from "../extension/src/webdav.js";

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function many(w, n, feedId = 1, from = 1000, hours = 5) {
  const f = w.mf.st.feeds.find(x => x.id === feedId); const out = [];
  for (let i = 0; i < n; i++) { const e = entry(from + i, feedId, `Bulk story ${from + i} about harbour cranes`, `Body ${from + i}`, hours + i / 100); e.feed = { id: feedId, title: f.title, category: f.category }; w.mf.st.entries.push(e); out.push(e.id); }
  return out;
}
const unreadOnServer = (w) => w.mf.st.entries.filter(e => e.status === "unread").length;

// ---------- mark all read ----------
test("a large mark-read goes to Miniflux in chunks, is verified, and leaves nothing unread", async () => {
  const w = await world(); many(w, 400); const { e } = await w.mk("laptop"); await e.syncNow();
  const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id); assert.ok(ids.length >= 400);
  w.mf.st.puts.length = 0; const res = await e.markRead(ids);
  assert.ok(w.mf.st.puts.length >= 3 && w.mf.st.puts.every(n => n <= 150), "no single request carries more than 150 ids: " + w.mf.st.puts);
  assert.equal(w.mf.st.puts.reduce((a, b) => a + b, 0), ids.length);
  assert.equal(unreadOnServer(w), 0); assert.equal(res.verified, true); assert.equal(res.retried, 0); assert.equal(res.count, ids.length); assert.equal(res.ids.length, ids.length);
  assert.equal(e.status().pendingCount, 0);
});
test("articles Miniflux silently fails to update are found by the check and sent again", async () => {
  const w = await world(); const added = many(w, 60); const { e } = await w.mk("laptop"); await e.syncNow();
  const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id);
  w.mf.st.flaky = { ids: new Set(added.slice(0, 10)), times: 1 };
  const res = await e.markRead(ids);
  assert.equal(res.verified, true); assert.equal(res.retried, 10); assert.equal(unreadOnServer(w), 0);
});
test("when Miniflux never applies some of them, the result says so plainly instead of claiming success", async () => {
  const w = await world(); const added = many(w, 60); const { e } = await w.mk("laptop"); await e.syncNow();
  const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id);
  w.mf.st.flaky = { ids: new Set(added.slice(0, 7)), times: 99 };
  const res = await e.markRead(ids);
  assert.equal(res.verified, false); assert.equal(res.failed, 7); assert.equal(e.cache.items[added[0]].status, "read", "the local copy still shows them read");
  assert.equal(unreadOnServer(w), 7);
});
test("a failure half way through a bulk mark resends only what has not arrived", async () => {
  const w = await world(); many(w, 400); const { e } = await w.mk("laptop"); await e.syncNow();
  const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id);
  const orig = e.mf.setStatus.bind(e.mf); let n = 0; e.mf.setStatus = async (a, s) => { if (++n === 2) throw new PlainError("Could not reach Miniflux.", "unreachable"); return orig(a, s); };
  w.mf.st.puts.length = 0; const res = await e.markRead(ids, { verify: false });
  assert.equal(res.pending, ids.length - 150, "150 arrived, the rest wait"); assert.equal(e.net.miniflux.error.code, "unreachable");
  assert.equal(e.status().lights.find(l => l.id === "miniflux").state, "red");
  await e.syncNow(); assert.equal(unreadOnServer(w), 0); assert.equal(e.pendingOps.length, 0);
  assert.equal(w.mf.st.puts.reduce((a, b) => a + b, 0), ids.length, "nothing was sent twice");
});
test("a refresh that read Miniflux while a mark-read was being sent does not bring those articles back", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const before = JSON.parse(JSON.stringify(w.mf.st.entries.filter(x => x.status === "unread"))); let release; const gate = new Promise(r => { release = r; });
  w.mf.st.stale = { entries: before, waitFor: () => gate };
  const refreshing = e.refresh(); await wait(25);
  await e.markRead([1, 2], { verify: false }); release(); await refreshing;
  assert.equal(e.cache.items[1].status, "read"); assert.equal(e.cache.items[2].status, "read"); assert.equal(e.pendingOps.length, 0);
  assert.equal(w.mf.st.entries.find(x => x.id === 1).status, "read");
});
test("marking a scope covers every unread article in it, not just what was on screen", async () => {
  const w = await world(); many(w, 300, 1); many(w, 5, 2, 5000); const { e } = await w.mk("laptop"); await e.syncNow();
  const r = await e.markScope("feed:1"); assert.ok(r.count >= 301); assert.equal(r.verified, true);
  assert.ok(w.mf.st.entries.filter(x => x.feed_id === 1).every(x => x.status === "read")); assert.ok(w.mf.st.entries.filter(x => x.feed_id === 2).some(x => x.status === "unread"), "another feed is untouched");
  const f = await e.markScope("cat:Food"); assert.ok(f.count >= 6, "a folder covers the feeds inside it"); assert.equal(unreadOnServer(w), 0);
  assert.equal((await e.markScope("all")).count, 0);
  const again = await e.markScope("all"); assert.equal(again.count, 0, "nothing to do is reported, not an error");
});
test("the engine reports what it is doing, so the screen can show it", async () => {
  const w = await world(); many(w, 300); const { e } = await w.mk("laptop"); await e.syncNow(); w.mf.st.delay = 40;
  const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id); const seen = [];
  e.onChange = () => { const a = e.status().activity; if (a) seen.push(`${a.kind}:${a.done}/${a.total}`); };
  const p = e.markRead(ids, { verify: false }); await wait(60); const mid = e.status(); await p;
  assert.equal(mid.activity.kind, "push"); assert.ok(mid.pendingCount > 0); assert.ok(seen.length >= 2);
  assert.equal(e.status().activity, null); assert.equal(e.status().pendingCount, 0);
});

// ---------- search ----------
test("search finds by loose words, tags, feed names, phrases and exclusions", async () => {
  const w = await world(); w.mf.st.entries[0].tags = ["navy", "procurement"]; const { e } = await w.mk("laptop"); await e.syncNow();
  const hit = (q) => e.search(q).rows.map(r => r.id).sort();
  assert.deepEqual(hit("frigate"), [1, 3]); assert.deepEqual(hit("frigat"), [1, 3], "a stem is enough");
  assert.deepEqual(hit("frigte shipyrd"), [1, 3], "misspellings still match");
  assert.deepEqual(hit("#navy"), [1]); assert.deepEqual(hit("feed:kitchen"), [2]); assert.deepEqual(hit("feed:naval frigate -broken"), [1]);
  assert.deepEqual(hit('"lemon cake"'), [2]); assert.deepEqual(hit("lemon -cake"), []); assert.deepEqual(hit("zebra"), []);
  assert.deepEqual(e.search("").rows, []); assert.equal(e.search("").empty, true);
  assert.deepEqual(hit("frigate in:saved"), []); await e.markRead([1]); assert.deepEqual(hit("frigate in:read"), [1]); assert.deepEqual(hit("frigate in:unread"), [3]);
  assert.deepEqual(hit("deficit since:1d"), [], "entry 4 is 30 hours old"); assert.deepEqual(hit("deficit since:5d"), [4]);
  const r = e.search("navy orders").rows[0]; assert.equal(r.id, 1); assert.equal(r.indexOnly, false); assert.ok(Number.isFinite(r.score));
});
test("search never runs HTML or regex from the query, and handles odd input", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  for (const q of ["<script>alert(1)</script>", "(((", "[a-", "\\", '"', "#", "feed:", "in:nonsense", "-", "a".repeat(5000), "ａｂｃ", "\u0000"]) assert.doesNotThrow(() => e.search(q), q.slice(0, 12));
});
test("an article read long ago stays searchable after its reading copy expires, and can be brought back", async () => {
  const w = await world(); const { e, storage } = await w.mk("laptop"); await e.syncNow(); await e.markRead([4]); e.settings.retentionDays = 0;
  await e.refresh(); assert.equal(e.cache.items[4], undefined, "the reading copy is gone");
  const r = e.search("fiscal deficit").rows; assert.equal(r.length, 1); assert.equal(r[0].id, 4); assert.equal(r[0].indexOnly, true); assert.equal(r[0].read, true);
  await e.persist(["searchIndex"]); const e2 = new (e.constructor)({ storage, fetchImpl: w.fetchImpl }); await e2.load(); assert.equal(e2.search("fiscal deficit").rows[0].id, 4, "the index survives a restart");
  assert.equal(await e.restore(4), true); assert.equal(e.cache.items[4].status, "read"); assert.equal(e.search("fiscal").rows[0].indexOnly, false);
});
test("the index remembers what the full text says, not only the title", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  assert.deepEqual(e.search("zeppelin").rows, []);
  w.mf.st.entries.find(x => x.id === 2).content = "<p>Notes on baking. The zeppelin bakery zeppelin dough zeppelin oven.</p>"; const c = await e.getContent(2); assert.match(c.html, /zeppelin/);
  assert.deepEqual(e.search("zeppelin").rows.map(r => r.id), [2]);
});
test("old articles are dropped from the index after the keep period, and the index has a size limit", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  e.searchIndex[777] = { id: 777, fi: 1, f: "Old", t: "Ancient thing", g: [], k: "", s: "", p: Date.now() - 500 * 86400000, u: "https://x.example/777", c: "" };
  e.searchIndex[778] = { ...e.searchIndex[777], id: 778, p: Date.now() - 10 * 86400000 }; e._reindex();
  assert.equal(e.searchIndex[777], undefined); assert.ok(e.searchIndex[778]); assert.ok(e.searchIndex[1], "articles in the cache are never dropped");
});
test("searching Miniflux adds older articles to the local index", async () => {
  const w = await world(); w.mf.st.entries.push(entry(50, 1, "Ancient dreadnought archive", "dreadnought", 24 * 200, { status: "read" })); const { e } = await w.mk("laptop"); await e.syncNow();
  assert.deepEqual(e.search("dreadnought").rows, []);
  const r = await e.searchServer("dreadnought in:read #x"); assert.equal(r.ok, true); assert.equal(r.found, 1); assert.match(r.sentence, /found 1 article/);
  const hit = e.search("dreadnought").rows[0]; assert.equal(hit.id, 50); assert.equal(hit.indexOnly, true);
  w.ctl.mfDown = true; const bad = await e.searchServer("anything"); assert.equal(bad.ok, false); assert.match(bad.sentence, /Could not reach Miniflux/);
  assert.equal((await e.searchServer("   ")).ok, false);
});

// ---------- folder order ----------
test("folders and feeds can be moved up and down, the order is remembered, and the list follows it", async () => {
  const w = await world(); const { e, storage } = await w.mk("laptop"); await e.syncNow();
  const labels = () => e.tree().map(n => n.label);
  assert.deepEqual(labels(), ["Defence", "Shipbuilding", "Naval Wire", "Food", "Broken Feed", "Kitchen Daily"]);
  const t = e.tree(); assert.equal(t.find(n => n.id === "cat:Defence").first, true); assert.equal(t.find(n => n.id === "cat:Food").last, true);
  assert.equal(await e.moveNode("cat:Defence", "up"), false, "already first"); assert.equal(await e.moveNode("cat:Food", "down"), false, "already last");
  assert.equal(await e.moveNode("cat:Food", "up"), true); assert.deepEqual(labels(), ["Food", "Broken Feed", "Kitchen Daily", "Defence", "Shipbuilding", "Naval Wire"]);
  assert.equal(await e.moveNode("feed:2", "up"), false, "feeds are ordered in Miniflux, not here"); assert.equal(await e.moveNode("cat:Defence/Shipbuilding", "up"), false, "only top-level folders move");
  const v = e.getView({ scope: "all", mode: "all" }); assert.deepEqual(v.groups.map(g => g.title), ["Broken Feed", "Kitchen Daily", "Naval Wire"], "the article list follows the sidebar");
  assert.equal(await e.moveNode("cat:nope", "up"), false);
  const e2 = new (e.constructor)({ storage, fetchImpl: w.fetchImpl }); await e2.load(); assert.deepEqual(e2.tree().map(n => n.label).slice(0, 3), ["Food", "Broken Feed", "Kitchen Daily"], "remembered across a restart");
  await e.saveSettings({ pollMinutes: 5 }); assert.deepEqual(labels().slice(0, 2), ["Food", "Broken Feed"], "saving other settings keeps the order");
});

// ---------- discovery and subscribing ----------
test("discovering feeds on a page asks Miniflux, marks ones already followed, and explains failures", async () => {
  const w = await world(); w.mf.st.feeds[0].feed_url = "https://navalnews.example/rss"; const { e } = await w.mk("laptop"); await e.syncNow();
  w.mf.st.discover["https://blog.example"] = [{ url: "https://blog.example/feed.xml", title: "Blog", type: "atom" }, { url: "https://navalnews.example/rss", title: "Naval", type: "rss" }, { url: "javascript:alert(1)", title: "bad" }];
  const r = await e.discover("blog.example"); assert.equal(r.ok, true); assert.equal(r.url, "https://blog.example"); assert.equal(r.feeds.length, 2, "an unsafe address is dropped");
  assert.equal(r.feeds[0].subscribed, false); assert.equal(r.feeds[1].subscribed, true);
  const none = await e.discover("https://empty.example/"); assert.equal(none.ok, false); assert.match(none.sentence, /Miniflux said: Unable to find any subscription/);
  assert.equal((await e.discover("")).ok, false); assert.equal((await e.discover("http://")).ok, false);
});
test("subscribing puts the feed in the chosen folder, or in a new one, and it appears at once", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  const cats = await e.categoryList(); const food = cats.find(c => c.title === "Food"); assert.ok(food);
  const a = await e.subscribe({ feedUrl: "https://blog.example/feed.xml", categoryId: food.id }); assert.equal(a.ok, true);
  const node = e.tree().find(n => n.id === "feed:" + a.feedId); assert.equal(node.parent, "cat:Food"); assert.equal(e.cache.feeds.find(f => f.id === a.feedId).feedUrl, "https://blog.example/feed.xml");
  assert.ok(Object.values(e.cache.items).some(i => i.feedId === a.feedId), "its first article arrived");
  const b = await e.subscribe({ feedUrl: "https://world.example/rss", newCategory: "News/World" }); assert.equal(b.ok, true);
  assert.equal(e.tree().find(n => n.id === "feed:" + b.feedId).parent, "cat:News/World"); assert.ok(e.tree().some(n => n.id === "cat:News" && n.type === "folder"), "the parent folder appears");
  const dup = await e.subscribe({ feedUrl: "https://blog.example/feed.xml", categoryId: food.id }); assert.equal(dup.ok, false); assert.match(dup.sentence, /already exists/);
  assert.equal((await e.subscribe({ feedUrl: "ftp://x", categoryId: 1 })).ok, false); assert.equal((await e.subscribe({ feedUrl: "javascript:1" })).ok, false);
  w.ctl.mfDown = true; assert.equal((await e.subscribe({ feedUrl: "https://z.example/f", categoryId: 1 })).ok, false);
});
test("without a Miniflux key, discovery and subscribing say so instead of failing", async () => {
  const w = await world(); const { e } = await w.mk("laptop", { miniflux: { url: "https://mf.test", token: "" } });
  assert.equal((await e.discover("https://a.example")).ok, false); assert.equal((await e.subscribe({ feedUrl: "https://a.example/f" })).ok, false); assert.deepEqual(await e.categoryList(), []); assert.equal((await e.searchServer("x")).ok, false);
});

// ---------- a mark-read that did not stick ----------
test("a read that Miniflux dropped is sent again by the next refresh instead of reappearing as unread", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow();
  w.mf.st.flaky = { ids: new Set([1]), times: 1 }; await e.markRead([1, 2], { verify: false });
  assert.equal(w.mf.st.entries.find(x => x.id === 1).status, "unread", "Miniflux ignored it");
  await e.refresh(); assert.equal(e.cache.items[1].status, "read", "still shown read here"); assert.equal(w.mf.st.entries.find(x => x.id === 1).status, "read", "and now it is read on Miniflux");
});
test("the resending gives up after a few tries and then believes Miniflux, so it cannot loop", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); w.mf.st.flaky = { ids: new Set([1]), times: 99 }; await e.markRead([1], { verify: false }); w.mf.st.puts.length = 0;
  for (let i = 0; i < 8; i++) await e.refresh();
  assert.ok(w.mf.st.puts.length <= 3, "at most three resends: " + w.mf.st.puts.length); assert.equal(e.cache.items[1].status, "unread", "after that the reader shows what Miniflux says");
});
test("a read marked unread again is not fought over", async () => {
  const w = await world(); const { e } = await w.mk("laptop"); await e.syncNow(); await e.markRead([1], { verify: false }); await e.markUnread([1]); w.mf.st.puts.length = 0;
  await e.refresh(); assert.equal(e.cache.items[1].status, "unread"); assert.equal(w.mf.st.entries.find(x => x.id === 1).status, "unread"); assert.deepEqual(w.mf.st.puts, []);
});
