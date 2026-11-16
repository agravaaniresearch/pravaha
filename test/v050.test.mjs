// 0.5.0: feed detection, the optional permission, and the right-click subscribe item.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { FeedDetect, cleanFeeds, SCRIPT_ID, MATCHES } from "../extension/src/feeddetect.js";

function fakeApi({ granted = false } = {}) {
  const calls = []; const store = {}; const scripts = new Map(); const st = { granted };
  const rec = (name) => async (a) => { calls.push([name, a]); };
  return { calls, scripts, st, runtime: { id: "pravaha@agravaani" },
    storage: { session: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
    action: { setIcon: rec("icon"), setBadgeText: rec("badge"), setBadgeBackgroundColor: rec("badgeBg"), setBadgeTextColor: rec("badgeFg"), setTitle: rec("title"), setPopup: rec("popup") },
    permissions: { contains: async () => st.granted, remove: async () => { st.granted = false; return true; } },
    scripting: { getRegisteredContentScripts: async ({ ids }) => ids.filter(i => scripts.has(i)).map(id => scripts.get(id)), registerContentScripts: async (l) => { for (const x of l) scripts.set(x.id, x); }, unregisterContentScripts: async ({ ids }) => { for (const i of ids) { if (!scripts.has(i)) throw new Error("none"); scripts.delete(i); } } } };
}
const tab = (id, url = "https://blog.example/") => ({ id, url });

test("cleanFeeds keeps at most eight http(s) feeds, drops junk and duplicates, and shortens text", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://x.example/f${i}.xml`, title: "t".repeat(300), type: "atom" }));
  const out = cleanFeeds([...many, { url: "javascript:alert(1)" }, { url: "ftp://x/y" }, null, { url: 5 }, { url: "https://x.example/f0.xml" }]);
  assert.equal(out.length, 8); assert.ok(out.every(f => /^https:/.test(f.url) && f.title.length === 120)); assert.deepEqual(cleanFeeds("nope"), []);
  assert.equal(cleanFeeds([{ url: "https://a.example/f", type: "weird" }])[0].type, "rss", "an unknown type becomes rss");
});
test("a report from a tab colours that tab's icon, sets a badge, title and popup; navigating clears them", async () => {
  const api = fakeApi(); const d = new FeedDetect(api);
  const r = await d.found({ id: "pravaha@agravaani", tab: tab(7) }, { feeds: [{ url: "https://blog.example/feed.xml", title: "The Blog", type: "atom" }, { url: "https://blog.example/c.xml", type: "rss" }] });
  assert.deepEqual(r, { ok: true, count: 2 }); const by = Object.fromEntries(api.calls.map(([n, a]) => [n, a]));
  assert.equal(by.icon.tabId, 7); assert.match(by.icon.path[32], /icon-feed-32/); assert.equal(by.badge.text, "2"); assert.match(by.title.title, /Subscribe with Pravaha \(2 feeds/); assert.equal(by.popup.popup, "ui/popup.html");
  assert.equal((await d.get(7)).length, 2); assert.deepEqual(await d.get(8), []);
  api.calls.length = 0; await d.clear(7); assert.deepEqual(await d.get(7), []); const c = Object.fromEntries(api.calls.map(([n, a]) => [n, a]));
  assert.equal(c.icon.path, null); assert.equal(c.badge.text, null, "a cleared tab falls back to the toolbar-wide badge"); assert.equal(c.popup.popup, null); api.calls.length = 0; await d.clear(7); assert.equal(api.calls.length, 0, "clearing a tab with nothing does nothing");
  const one = await d.found({ id: "pravaha@agravaani", tab: tab(9) }, { feeds: [{ url: "https://s.example/rss", type: "rss" }] }); assert.equal(one.count, 1); assert.match(api.calls.find(c => c[0] === "title")[1].title, /\(1 feed found/);
});
test("reports from anything but this extension's own tab script are ignored", async () => {
  const api = fakeApi(); const d = new FeedDetect(api); const feeds = [{ url: "https://a.example/f", type: "rss" }];
  assert.equal((await d.found({ id: "evil@x", tab: tab(1) }, { feeds })).ok, false); assert.equal((await d.found({ id: "pravaha@agravaani" }, { feeds })).ok, false, "no tab");
  assert.equal((await d.found({ id: "pravaha@agravaani", tab: tab(1) }, { feeds: [{ url: "file:///etc/passwd" }] })).ok, false, "no usable feeds"); assert.equal(api.calls.length, 0);
});
test("the state survives the event page unloading, because it lives in session storage", async () => {
  const api = fakeApi(); await new FeedDetect(api).found({ id: "pravaha@agravaani", tab: tab(3) }, { feeds: [{ url: "https://a.example/f", type: "rss" }] });
  assert.equal((await new FeedDetect(api).get(3)).length, 1);
});
test("the script is registered only once the permission is held, and turning it off removes both", async () => {
  const api = fakeApi(); const d = new FeedDetect(api);
  assert.deepEqual(await d.state(), { granted: false, registered: false, on: false });
  const no = await d.enable(); assert.equal(no.ok, false); assert.equal(api.scripts.size, 0, "nothing is registered without the permission");
  api.st.granted = true; const yes = await d.enable(); assert.equal(yes.ok, true); assert.equal(yes.on, true);
  const reg = api.scripts.get(SCRIPT_ID); assert.deepEqual(reg.matches, MATCHES); assert.deepEqual(reg.js, ["content/detect.js"]); assert.equal(reg.persistAcrossSessions, true); assert.equal(reg.allFrames, false);
  await d.enable(); assert.equal(api.scripts.size, 1, "enabling twice registers once");
  const off = await d.disable(); assert.equal(off.on, false); assert.equal(api.st.granted, false); assert.equal(api.scripts.size, 0);
  assert.equal((await d.disable()).ok, true, "turning off twice is fine");
});
test("withdrawing the permission in Firefox stops the script too", async () => {
  const api = fakeApi({ granted: true }); const d = new FeedDetect(api); await d.enable(); api.st.granted = false;
  const s = await d.sync(); assert.equal(s.registered, false); assert.equal(api.scripts.size, 0);
});

function runContentScript(html, { top = true } = {}) {
  const dom = new JSDOM(html, { url: "https://blog.example/post/1", runScripts: "outside-only" }); const sent = [];
  dom.window.browser = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } };
  let win = dom.window;
  if (!top) { const f = dom.window.document.createElement("iframe"); dom.window.document.body.append(f); win = f.contentWindow; win.browser = dom.window.browser; win.document.head.innerHTML = '<link rel="alternate" type="application/rss+xml" href="/f">'; }
  win.eval(fs.readFileSync(new URL("../extension/content/detect.js", import.meta.url), "utf8")); return { get sent() { return JSON.parse(JSON.stringify(sent)); }, dom };
}
test("the page script finds rss, atom and json feed links, resolves relative addresses, and ignores everything else", () => {
  const { sent } = runContentScript(`<head><link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml"><link rel="alternate" type="application/atom+xml" href="https://blog.example/atom"><link rel="alternate" type="application/feed+json" href="feed.json">
    <link rel="alternate" type="text/html" href="/fr"><link rel="stylesheet" type="text/css" href="/a.css"><link rel="alternate" type="application/json" href="/api/page"><link rel="alternate" type="application/json" href="/feed/json"><link rel="alternate" type="application/rss+xml" href="javascript:alert(1)"></head><body>Secret text</body>`);
  assert.equal(sent.length, 1); assert.equal(sent[0].type, "feedsFound");
  assert.deepEqual(sent[0].feeds.map(f => [f.url, f.type, f.title]), [["https://blog.example/feed.xml", "rss", "Posts"], ["https://blog.example/atom", "atom", ""], ["https://blog.example/post/feed.json", "json", ""], ["https://blog.example/feed/json", "json", ""]]);
  assert.equal(JSON.stringify(sent).includes("Secret text"), false, "page text is never sent");
});
test("the page script stays quiet when there is no feed or it runs in a frame", () => {
  assert.equal(runContentScript("<head><title>x</title></head><body></body>").sent.length, 0);
  assert.equal(runContentScript(`<head><link rel="alternate" type="application/rss+xml" href="/f"></head>`, { top: false }).sent.length, 0);
});
test("the page script notices a feed link added after the page loaded, once", async () => {
  const r = runContentScript("<head></head><body></body>"); const dom = r.dom; assert.equal(r.sent.length, 0);
  const l = dom.window.document.createElement("link"); l.rel = "alternate"; l.type = "application/atom+xml"; l.href = "/late.xml"; dom.window.document.head.append(l); await new Promise(r => setTimeout(r, 30));
  assert.equal(r.sent.length, 1); assert.equal(r.sent[0].feeds[0].url, "https://blog.example/late.xml"); dom.window.close();
});
test("the manifest asks for no all-sites permission up front, and the right-click item is named Subscribe with Pravaha", () => {
  const m = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")); const bg = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.equal(m.version, "0.8.6"); assert.equal(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, m.version);
  assert.ok(m.permissions.includes("scripting")); assert.ok(m.host_permissions.every(h => !/\*:\/\/\*|https:\/\/\*\/|http:\/\/\*\//.test(h)), "no all-sites host permission at install");
  assert.deepEqual(m.optional_host_permissions, ["https://*/*", "http://*/*"]); assert.equal(m.content_scripts, undefined, "no content script is declared up front");
  assert.match(bg, /title: "Subscribe with Pravaha"/); assert.doesNotMatch(bg, /Find feeds here/);
  for (const f of ["icons/icon-feed-16.png", "icons/icon-feed-32.png", "content/detect.js", "ui/popup.html", "ui/popup.js", "ui/popup.css"]) assert.ok(fs.existsSync(new URL("../extension/" + f, import.meta.url)), f + " exists");
});
