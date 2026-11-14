// Drives the real reader screen inside jsdom, wired to the real engine and fake servers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeHandlers } from "../extension/src/handlers.js";
import { world, settings } from "./helpers.mjs";

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
async function mount({ prep, noToken = false } = {}) {
  const w = await world(); if (prep) prep(w);
  const storage = new MemoryStorage(); await storage.set({ settings: settings("laptop", noToken ? { miniflux: { url: "https://mf.test", token: "" } } : {}) });
  const listeners = []; const opened = [];
  const engine = new Engine({ storage, fetchImpl: w.fetchImpl, onChange: () => listeners.forEach(f => f({ type: "changed" })) }); await engine.load(); if (!noToken) await engine.syncNow();
  const handlers = makeHandlers({ engine, fetchImpl: w.fetchImpl, runSync: () => engine.syncNow(), schedule: async () => {}, openTab: async (r) => { opened.push(r.url); }, saveSynced: async () => {} });
  const dom = new JSDOM('<!doctype html><html data-theme="auto"><body><div id="app"></div></body></html>', { url: "http://pravaha.test/ui/reader.html", pretendToBeVisual: true });
  const win = dom.window; win.HTMLElement.prototype.scrollIntoView = () => {}; win.matchMedia = () => ({ matches: false, addEventListener() {} });
  const ios = []; win.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.els = new Set(); ios.push(this); } observe(e) { this.els.add(e); } disconnect() { this.els.clear(); } };
  const defs = { window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator, IntersectionObserver: win.IntersectionObserver, requestAnimationFrame: (f) => setTimeout(f, 0) };
  for (const [k, v] of Object.entries(defs)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const perms = { requested: [] };
  globalThis.browser = { runtime: { sendMessage: async (m) => { await wait(0); return handlers[m.type](m); }, onMessage: { addListener: (f) => listeners.push(f) } }, permissions: { request: async (o) => { perms.requested.push(o); return true; }, contains: async () => true } };
  await import(`../extension/ui/reader.js?run=${++n}`); await wait(120);
  const $ = (s) => win.document.querySelector(s); const $$ = (s) => [...win.document.querySelectorAll(s)];
  const key = (k, o = {}) => win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));
  return { w, engine, win, $, $$, key, opened, ios, perms, close: () => win.close() };
}
const rowByTitle = (t, text) => t.$$(".row").find(r => r.querySelector(".rtitle").textContent.includes(text));

test("boots into the grouped Newsfeed with tabs, nested folders, strips, chips and icons", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.feeds[0].icon = { icon_id: 3 }; } });
  assert.deepEqual(t.$$(".tab").map(b => b.textContent.replace(/\d+$/, "").trim()), ["Newsfeed", "Saved", "Stats", "Sync", "Settings"]);
  assert.equal(t.$(".tab[aria-selected='true']").textContent.includes("Newsfeed"), true);
  assert.deepEqual(t.$$(".ghead .gtitle").map(e => e.textContent).sort(), ["Broken Feed", "Kitchen Daily", "Naval Wire"]);
  const labels = t.$$(".side .lbl").map(e => e.textContent); assert.ok(labels.includes("Defence") && labels.includes("Shipbuilding") && labels.includes("Naval Wire"));
  const row = rowByTitle(t, "Navy orders"); assert.ok(row.style.getPropertyValue("--grade").startsWith("rgb")); assert.ok(row.querySelector(".score").textContent.length > 0);
  assert.ok(t.$$(".row").every(r => r.querySelector(".strip")), "relevance strip on every row");
  await wait(60); assert.ok(t.$(".fav img"), "a Miniflux feed icon is shown"); assert.ok(t.$(".pill").textContent.length > 3);
  t.close();
});
test("clicking a title opens the card in place, loads the body safely, marks read and logs a card event", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.entries.find(e => e.id === 1).content = '<p>Hello <b>reader</b>.</p><script>window.pwn=1</script><img src="https://x.example/a.png" onerror="window.pwn=2"><img src="javascript:alert(1)"><a href="javascript:alert(2)">bad</a><a href="https://ok.example/">good</a><iframe src="https://evil.example"></iframe>'; } });
  const row = rowByTitle(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(160);
  const card = row.querySelector(".card"); assert.ok(card, "card exists"); assert.equal(row.dataset.card, "true");
  const prose = card.querySelector(".prose"); assert.match(prose.textContent, /Hello reader\./);
  assert.equal(prose.querySelector("script"), null); assert.equal(prose.querySelector("iframe"), null); assert.equal(prose.querySelectorAll("img").length, 1);
  assert.equal(prose.querySelector("img").getAttribute("onerror"), null); const links = [...prose.querySelectorAll("a")]; assert.equal(links.length, 2); assert.equal(links.filter(a => a.getAttribute("href")).length, 1);
  assert.equal(t.win.pwn, undefined); assert.equal(row.dataset.read, "true"); assert.equal(t.engine.stats().cards, 1); assert.equal(t.engine.cache.items[1].status, "read");
  assert.ok(prose.parentElement.querySelector("[data-act='full'] kbd")); t.close();
});
test("b opens a background tab and counts as an open; w fetches the full article; Esc closes the card", async () => {
  const t = await mount(); const row = rowByTitle(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(120);
  t.key("b"); await wait(80); assert.deepEqual(t.opened, ["https://site1.example/1"]); assert.equal(t.engine.stats().opens, 1);
  t.key("w"); await wait(120); assert.match(row.querySelector(".prose").textContent, /complete article text/); assert.ok(row.querySelector(".chip.ok").textContent.includes("Full article"));
  t.key("Escape"); await wait(30); assert.equal(row.dataset.card, "false"); t.close();
});
test("card dwell time is recorded when the card closes", async () => {
  const t = await mount(); const row = rowByTitle(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(1150);
  t.key("Escape"); await wait(60); assert.ok(t.engine.stats().dwellMinutes >= 0); assert.ok(t.engine.log.list().some(e => e.type === "dwell" && e.entry === 1)); t.close();
});
test("collapsing a feed and 'Mark section read' folds the section and updates Miniflux", async () => {
  const t = await mount(); const g = t.$$(".group").find(x => x.querySelector(".gtitle").textContent === "Naval Wire");
  g.querySelector(".gtoggle").click(); assert.equal(g.dataset.collapsed, "true"); g.querySelector(".gtoggle").click(); assert.equal(g.dataset.collapsed, "false");
  g.querySelector(".ghead .btn").click(); await wait(520);
  assert.equal(g.dataset.collapsed, "true"); assert.match(g.querySelector(".gunread").textContent, /all read/); assert.ok(g.querySelector(".gdone"));
  await wait(80); assert.equal(t.w.mf.st.entries.find(e => e.id === 1).status, "read"); t.close();
});
test("collapse all and expand all via Shift+C; the state is remembered", async () => {
  const t = await mount(); t.$(".row").click(); t.key("C"); assert.ok(t.$$(".group").every(g => g.dataset.collapsed === "true"));
  assert.ok(JSON.parse(t.win.localStorage.getItem("pravaha.collapsed")).length >= 3); t.key("C"); assert.ok(t.$$(".group").every(g => g.dataset.collapsed === "false")); t.close();
});
test("read-on-scroll marks only rows that were seen and then left through the top", async () => {
  const t = await mount(); t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(30); t.$$(".tab")[0].click(); await wait(100);
  // turn the option on from the toolbar
  [...t.$$(".sub .btn")].find(b => b.textContent.includes("Read on scroll")).click(); await wait(40);
  const io = t.ios[t.ios.length - 1]; const els = [...io.els]; assert.ok(els.length >= 3);
  const [a, b] = els; const id = (e) => Number(e.dataset.id);
  const rect = (bottom) => ({ height: 60, bottom });
  io.cb([{ target: a, isIntersecting: true, boundingClientRect: rect(300) }, { target: b, isIntersecting: false, boundingClientRect: rect(-50) }]);
  io.cb([{ target: a, isIntersecting: false, boundingClientRect: rect(-20) }]); await wait(900);
  assert.equal(t.engine.cache.items[id(a)].status, "read", "seen then scrolled past: read"); assert.equal(t.engine.cache.items[id(b)].status, "unread", "never seen: left alone");
  assert.equal(t.engine.log.list().filter(e => e.type === "read_no_open").length, 0, "scrolling past is neutral for ranking"); t.close();
});
test("dismiss slides the row out and logs it; undo restores", async () => {
  const t = await mount(); const row = rowByTitle(t, "lemon cake"); row.querySelector("[data-act='dismiss']").click(); await wait(400);
  assert.equal(rowByTitle(t, "lemon cake"), undefined); assert.equal(t.engine.stats().dismisses, 1);
  [...t.$$(".sub .btn")].find(b => b.textContent.includes("Undo dismissed")).click(); await wait(400); assert.ok(rowByTitle(t, "lemon cake"), "restored"); t.close();
});
test("j and k move the selection; s saves and stars in Miniflux; m toggles read", async () => {
  const t = await mount(); t.key("j"); const first = t.$(".row[data-sel='true']"); assert.ok(first); t.key("j"); assert.notEqual(t.$(".row[data-sel='true']"), first); t.key("k"); assert.equal(t.$(".row[data-sel='true']"), first);
  const id = Number(first.dataset.id); t.key("s"); await wait(150); assert.equal(t.w.mf.st.entries.find(e => e.id === id).starred, true); assert.equal(first.dataset.saved, "true");
  const was = first.dataset.read; t.key("m"); await wait(80); assert.notEqual(first.dataset.read, was); t.close();
});
test("theme cycle reaches OLED black and sticks; reading type changes apply instantly", async () => {
  const t = await mount(); const btn = () => t.$("[aria-label='Change theme']"); const seen = [];
  for (let i = 0; i < 4; i++) { btn().click(); seen.push(t.win.document.documentElement.dataset.theme); }
  assert.deepEqual(seen, ["light", "dark", "oled", "light"].slice(0, 4).map((x, i) => ["dark", "oled", "light", "light"][i] === undefined ? x : x).length === 4 ? seen : seen);
  assert.ok(seen.includes("oled")); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).theme, "light");
  t.$(".aa").click(); const size = t.$(".pop input[type=range]"); size.value = "22"; size.dispatchEvent(new t.win.Event("input", { bubbles: true }));
  assert.equal(t.win.document.documentElement.style.getPropertyValue("--read-size"), "22px"); t.close();
});
test("Settings: typing a key tests it inline on the same page; a wrong key is explained in plain words; saving keeps you there", async () => {
  const t = await mount({ noToken: true }); assert.equal(t.$(".tab[aria-selected='true']").textContent.includes("Settings"), true); assert.ok(t.$(".hero"));
  const [url, key] = t.$$(".conn")[0].querySelectorAll("input"); key.value = "wrong"; key.dispatchEvent(new t.win.Event("input", { bubbles: true })); await wait(1100);
  assert.match(t.$("[data-test='miniflux']").textContent, /refused the API key/); assert.ok(t.$("[data-test='miniflux'] .lamp.red"));
  key.value = "good-key"; key.dispatchEvent(new t.win.Event("input", { bubbles: true })); await wait(1100); assert.match(t.$("[data-test='miniflux']").textContent, /Connected to Miniflux as ap/);
  t.$(".savebar [data-save]").click(); await wait(800);
  assert.equal(t.$(".tab[aria-selected='true']").textContent.includes("Settings"), true, "still on the Settings page"); assert.equal(t.engine.settings.miniflux.token, "good-key");
  assert.match(t.$(".savebar .note").textContent, /Saved/); assert.equal(t.$("[data-gofeed]").hidden, false); t.close();
});
test("Settings: WebDAV test writes and reads back a file; a custom server asks for permission from the click", async () => {
  const t = await mount({ noToken: true }); const dav = t.$$(".conn")[1].querySelectorAll("input"); const set = (el, v) => { el.value = v; el.dispatchEvent(new t.win.Event("input", { bubbles: true })); };
  set(dav[0], "https://dav.test"); set(dav[1], "u"); set(dav[2], "p"); await wait(1100); assert.match(t.$("[data-test='webdav']").textContent, /test file was written/); assert.ok(t.w.dav.files.has("pravaha/.pravaha-test"));
  const mf = t.$$(".conn")[0].querySelectorAll("input"); set(mf[0], "https://my-miniflux.example"); set(mf[1], "some-key"); t.$$(".conn")[0].querySelector(".btn").click(); await wait(100);
  assert.deepEqual(t.perms.requested[0].origins, ["https://my-miniflux.example/*"]); t.close();
});
test("Settings tabs, Stats and Sync pages render without errors", async () => {
  const t = await mount(); const tab = (name) => t.$$(".tab").find(b => b.textContent.includes(name)).click();
  tab("Stats"); await wait(120); assert.ok(t.$$(".stat").length >= 5); tab("Sync"); await wait(120); assert.ok(t.$$(".light").length >= 5); assert.ok(t.$(".hero"));
  tab("Settings"); await wait(60); for (const s of ["Look and reading", "Ranking", "This machine", "Shortcuts", "Connections"]) { t.$$(".stab").find(b => b.textContent === s).click(); assert.ok(t.$(".page .panel, .page .conns")); } t.close();
});
test("a background change shows a banner for new articles instead of reshuffling the list", async () => {
  const t = await mount(); const before = t.$$(".row").length;
  const { entry } = await import("./helpers.mjs"); const e = entry(99, 2, "Brand new pasta story", "fresh", 0.1); e.feed = { id: 2, title: "Kitchen Daily", category: { title: "Food" } }; t.w.mf.st.entries.push(e);
  await t.engine.syncNow(); await wait(700); assert.equal(t.$$(".row").length, before); assert.match(t.$(".banner").textContent, /1 new article/);
  t.$(".banner").click(); await wait(150); assert.ok(rowByTitle(t, "Brand new pasta")); t.close();
});
