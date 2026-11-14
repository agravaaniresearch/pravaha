import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { renderSafe } from "../extension/src/safehtml.js";
import { testConnection } from "../extension/src/handlers.js";
import { world, settings } from "./helpers.mjs";

const doc = () => new JSDOM("<!doctype html><body></body>").window.document;
const render = (html) => { const d = doc(); const box = d.createElement("div"); box.append(renderSafe(html, d)); return box; };
async function engineOf(prep) { const w = await world(); if (prep) prep(w); const storage = new MemoryStorage(); await storage.set({ settings: settings("laptop") }); const e = new Engine({ storage, fetchImpl: w.fetchImpl, onChange() {} }); await e.load(); await e.syncNow(); return { w, e }; }

test("renderSafe drops scripts, frames, styles, event handlers and unsafe URLs but keeps readable markup", () => {
  const box = render('<h2>Title</h2><p onclick="x()">Hi <em>there</em> <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/p">ok</a></p><script>1</script><style>p{}</style><iframe src="https://e"></iframe><form action="https://e"><input></form><img src="data:text/html,x"><img src="https://i.example/a.png" srcset="x" onerror="y()"><svg onload="z()"></svg><object data="x"></object>');
  assert.equal(box.querySelectorAll("script,style,iframe,form,input,svg,object").length, 0);
  assert.equal(box.querySelector("p").getAttribute("onclick"), null); assert.ok(box.querySelector("em")); assert.ok(box.querySelector("h2"));
  const links = [...box.querySelectorAll("a")]; assert.equal(links.filter(a => a.getAttribute("href")).length, 1); assert.equal(links.find(a => a.getAttribute("href")).getAttribute("rel").includes("noopener"), true);
  const imgs = [...box.querySelectorAll("img")]; assert.equal(imgs.length, 1); assert.equal(imgs[0].getAttribute("onerror"), null); assert.equal(imgs[0].getAttribute("srcset"), null);
});
test("renderSafe stops at the node limit instead of rendering a runaway page", () => {
  const d = doc(); const frag = renderSafe("<p>x</p>".repeat(500), d, 50); const box = d.createElement("div"); box.append(frag); assert.ok(box.querySelectorAll("p").length <= 50);
});
test("openCard logs one card event per article per session and raises the feed's authority a little", async () => {
  const { e } = await engineOf(); const before = e.stats().cards; await e.openCard(1); await e.openCard(1); assert.equal(e.stats().cards, before + 1);
  assert.equal(e.log.list().filter(x => x.type === "card" && x.entry === 1).length, 1);
});
test("getContent caches the body; fetchFull replaces it and marks it full; failures give a plain sentence", async () => {
  const { e, w } = await engineOf((w) => { w.mf.st.entries.find(x => x.id === 1).content = "<p>Short summary</p>"; });
  const a = await e.getContent(1); assert.match(a.html, /Short summary/); assert.ok(!a.full);
  const r = await e.fetchFull(1); assert.equal(r.ok, true); const b = await e.getContent(1); assert.equal(b.full, true); assert.match(b.html, /complete article text/);
  const bad = await e.fetchFull(9999); assert.equal(bad.ok, false); assert.equal(typeof bad.sentence, "string");
});
test("refreshIcons stores feed icons as data URLs once, and does not refetch", async () => {
  const { e, w } = await engineOf((w) => { w.mf.st.feeds[0].icon = { icon_id: 3 }; });
  await e.refreshIcons(); assert.match(Object.values(e.icons).find(Boolean) || "", /^data:image\//); const n = Object.keys(e.icons).length; await e.refreshIcons(); assert.equal(Object.keys(e.icons).length, n);
});
test("articles carry thumbnail, word count, comments link and media enclosures from Miniflux", async () => {
  const { e } = await engineOf((w) => { const x = w.mf.st.entries.find(i => i.id === 1); x.comments_url = "https://news.example/c/1"; x.enclosures = [{ url: "https://m.example/a.mp3", mime_type: "audio/mpeg" }]; x.content = '<p>' + "word ".repeat(300) + '</p><img src="https://i.example/pic.jpg">'; });
  const row = e.getView({ scope: "all", mode: "unread" }).groups.flatMap(g => g.rows).find(r => r.id === 1);
  assert.equal(row.comments, "https://news.example/c/1"); assert.ok(row.media && row.media.length >= 1); assert.ok(row.words >= 250); assert.equal(row.thumb, "https://i.example/pic.jpg");
});
test("undoing a dismissal brings the article back as unread in Miniflux too", async () => {
  const { e, w } = await engineOf(); await e.dismiss(2); assert.equal(w.mf.st.entries.find(x => x.id === 2).status, "read");
  await e.undismissAll(); assert.equal(w.mf.st.entries.find(x => x.id === 2).status, "unread"); assert.ok(e.getView({ scope: "all", mode: "unread" }).groups.flatMap(g => g.rows).some(r => r.id === 2));
});
test("testConnection tests unsaved draft credentials and explains failures in plain words", async () => {
  const { e, w } = await engineOf();
  const ok = await testConnection("miniflux", { miniflux: { url: "https://mf.test", token: "good-key" } }, e, w.fetchImpl); assert.equal(ok.ok, true); assert.match(ok.sentence, /Connected to Miniflux/);
  const bad = await testConnection("miniflux", { miniflux: { url: "https://mf.test", token: "nope" } }, e, w.fetchImpl); assert.equal(bad.ok, false); assert.match(bad.sentence, /refused the API key/);
  const dav = await testConnection("webdav", { webdav: { url: "https://dav.test", user: "u", pass: "p", root: "pravaha" } }, e, w.fetchImpl); assert.equal(dav.ok, true);
});
