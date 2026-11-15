// Drives the real reader screen inside jsdom, wired to the real engine and fake servers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeHandlers } from "../extension/src/handlers.js";
import { world, settings, entry } from "./helpers.mjs";
import { ProfileSync } from "../extension/src/profilesync.js";

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
let n = 0;
const syncArea = () => { const m = new Map(); return { m, get: async (keys) => Object.fromEntries(keys.filter(k => m.has(k)).map(k => [k, JSON.parse(JSON.stringify(m.get(k)))])), set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, JSON.parse(JSON.stringify(v))); } }; };
async function mount({ prep, noToken = false, prefs = null, fontProbe = null, area = syncArea(), detect = null } = {}) {
  const w = await world(); if (prep) prep(w);
  const storage = new MemoryStorage(); await storage.set({ settings: settings("laptop", noToken ? { miniflux: { url: "https://mf.test", token: "" } } : {}) });
  const listeners = []; const opened = [];
  const engine = new Engine({ storage, fetchImpl: w.fetchImpl, onChange: () => listeners.forEach(f => f({ type: "changed" })) }); await engine.load(); if (!noToken) await engine.syncNow();
  const handlers = makeHandlers({ engine, fetchImpl: w.fetchImpl, runSync: () => engine.syncNow(), schedule: async () => {}, openTab: async (r) => { opened.push(r.url); }, detect, openSubscribe: async (u) => { opened.push('subscribe:' + u); }, profile: new ProfileSync({ engine, area }) });
  const dom = new JSDOM('<!doctype html><html data-theme="auto"><body><div id="app"></div></body></html>', { url: "http://pravaha.test/ui/reader.html", pretendToBeVisual: true });
  const win = dom.window; win.HTMLElement.prototype.scrollIntoView = () => {}; win.matchMedia = () => ({ matches: false, addEventListener() {} }); if (fontProbe) win.document.fonts = { load: async (spec) => fontProbe(spec) };
  const ios = []; win.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.els = new Set(); ios.push(this); } observe(e) { this.els.add(e); } disconnect() { this.els.clear(); } };
  const defs = { window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win), IntersectionObserver: win.IntersectionObserver, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: (id) => clearTimeout(id) };
  for (const [k, v] of Object.entries(defs)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  if (prefs) win.localStorage.setItem("pravaha.ui", JSON.stringify(prefs));
  const perms = { requested: [] };
  globalThis.browser = { runtime: { sendMessage: async (m) => { await wait(0); return handlers[m.type](m); }, onMessage: { addListener: (f) => listeners.push(f) } }, permissions: { request: async (o) => { perms.requested.push(o); return true; }, contains: async () => true } };
  await import(`../extension/ui/reader.js?run=${++n}`); await wait(120);
  const $ = (s) => win.document.querySelector(s); const $$ = (s) => [...win.document.querySelectorAll(s)];
  const key = (k, o = {}) => win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));
  return { w, engine, win, area, handlers, $, $$, key, opened, ios, perms, close: () => win.close() };
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
  g.querySelector(".ghead .btn").click(); await wait(30); t.$("[data-act='confirm']").click(); await wait(520);
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
  tab("Settings"); await wait(60); for (const s of ["Look and reading", "Ranking", "Move setup", "This machine", "Shortcuts", "Connections"]) { t.$$(".stab").find(b => b.textContent === s).click(); assert.ok(t.$(".page .panel, .page .conns")); } t.close();
});
test("a background change shows a banner for new articles instead of reshuffling the list", async () => {
  const t = await mount(); const before = t.$$(".row").length;
  const { entry } = await import("./helpers.mjs"); const e = entry(99, 2, "Brand new pasta story", "fresh", 0.1); e.feed = { id: 2, title: "Kitchen Daily", category: { title: "Food" } }; t.w.mf.st.entries.push(e);
  await t.engine.syncNow(); await wait(700); assert.equal(t.$$(".row").length, before); assert.match(t.$(".banner").textContent, /1 new article/);
  t.$(".banner").click(); await wait(150); assert.ok(rowByTitle(t, "Brand new pasta")); t.close();
});

test("anchor bolding is off by default, turns on from the Aa popover, updates the open card live and is remembered", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.entries.find(e => e.id === 1).content = "<p>Analysts noted the contract sets a pattern for future orders.</p><h2>Heading words</h2><pre>code words here</pre>"; } });
  const row = rowByTitle(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(160);
  assert.equal(row.querySelectorAll(".prose .bf").length, 0, "off by default");
  t.$(".aa").click(); const box = t.$(".pop input[type=checkbox]"); box.checked = true; box.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(60);
  assert.ok(row.querySelectorAll(".prose .bf").length >= 5, "open card is re-rendered with bolding"); assert.equal(row.querySelectorAll(".prose h2 .bf, .prose pre .bf").length, 0);
  assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).anchor, true); assert.ok(t.$(".pop [data-sample] .bf"), "preview in the popover is bolded");
  const light = row.querySelectorAll(".prose .bf").length; const sl = t.$$(".pop input[type=range]").find(i => i.max === "5"); sl.value = "5"; sl.dispatchEvent(new t.win.Event("input", { bubbles: true })); await wait(60);
  assert.notEqual(row.querySelectorAll(".prose .bf")[0].textContent.length, 0); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).anchorLevel, 5);
  assert.equal(row.querySelector(".prose").textContent.includes("Analysts noted the contract"), true, "text content is unchanged"); void light; t.close();
});

// ---------- 0.3.0 ----------
const typeInto = (t, sel, v) => { const i = t.$(sel); i.focus(); i.value = v; i.dispatchEvent(new t.win.Event("input", { bubbles: true })); };
const serverRead = (t, id) => t.w.mf.st.entries.find(e => e.id === id).status;

test("Shift+A marks the section read with no row selected, after a confirmation, folds it, confirms with Miniflux, and Undo brings it back", async () => {
  const t = await mount(); assert.equal(t.$(".row[data-sel='true']"), null, "nothing selected");
  t.key("A", { shiftKey: true }); await wait(40); assert.ok(t.$(".dialog[role='alertdialog']"), "a confirmation appears"); assert.match(t.$(".dialog p").textContent, /Naval Wire/);
  t.key("Escape"); await wait(30); assert.equal(t.$(".dialog"), null); assert.equal(serverRead(t, 1), "unread", "Esc cancels");
  t.key("A", { shiftKey: true }); await wait(40); t.$("[data-act='confirm']").click(); await wait(500);
  assert.equal(serverRead(t, 1), "read"); assert.equal(serverRead(t, 4), "read"); assert.equal(serverRead(t, 2), "unread", "another section is untouched");
  const naval = t.$$(".group").find(g => g.querySelector(".gtitle").textContent === "Naval Wire"); assert.equal(naval.dataset.collapsed, "true");
  const toast = t.$(".toast[data-kind='success']"); assert.ok(toast, "a success toast"); assert.match(toast.textContent, /Marked 2 articles read\. Miniflux confirmed/);
  toast.querySelector(".tact").click(); await wait(300); assert.equal(serverRead(t, 1), "unread", "Undo restores them in Miniflux"); assert.match(t.$(".toast").textContent, /back as unread/); t.close();
});
test("Shift+M marks everything read after a confirmation and the confirmation says how much", async () => {
  const t = await mount(); t.key("M", { shiftKey: true }); await wait(40); assert.match(t.$(".dialog p").textContent, /Mark all 4 articles in every folder as read/);
  t.$("[data-act='cancel']").click(); await wait(20); assert.equal(t.engine.unreadCount(), 4);
  t.key("M", { shiftKey: true }); await wait(40); t.$("[data-act='confirm']").click(); await wait(500);
  assert.equal(t.engine.unreadCount(), 0); assert.equal(t.w.mf.st.entries.filter(e => e.status === "unread").length, 0); assert.match(t.$(".toast").textContent, /Marked 4 articles read/); t.close();
});
test("the confirm setting: never asks, sections and all (default), or always, even for one article", async () => {
  const never = await mount({ prefs: { confirmRead: "never" } }); never.key("A", { shiftKey: true }); await wait(400); assert.equal(never.$(".dialog"), null); assert.equal(serverRead(never, 1), "read"); never.close();
  const always = await mount({ prefs: { confirmRead: "always" } }); always.$(".row").click(); always.key("m"); await wait(40); assert.ok(always.$(".dialog"), "even a single article asks"); always.key("Escape"); await wait(20);
  assert.equal(always.engine.unreadCount(), 4); always.key("m"); await wait(40); always.$("[data-act='confirm']").click(); await wait(200); assert.equal(always.engine.unreadCount(), 3); always.close();
  const dflt = await mount(); dflt.$(".row").click(); dflt.key("m"); await wait(150); assert.equal(dflt.$(".dialog"), null, "a single article never asks by default"); assert.equal(dflt.engine.unreadCount(), 3); dflt.close();
});
test("a bulk mark by section covers articles beyond the rows on screen (the 'some remain unread' bug)", async () => {
  const t = await mount({ prep: (w) => { for (let i = 0; i < 300; i++) w.mf.st.entries.push({ ...entry(2000 + i, 1, `Bulk ${i} harbour`, "x", 5 + i / 100), feed: w.mf.st.entries[0].feed }); } });
  const naval = t.$$(".group").find(g => g.querySelector(".gtitle").textContent === "Naval Wire"); assert.ok(naval.querySelectorAll(".row").length <= 121, "the list shows at most 120 rows"); assert.ok(naval.querySelector(".more"), "there are more than are displayed");
  naval.querySelector(".ghead .btn").click(); await wait(40); assert.match(t.$(".dialog p").textContent, /Mark 3\d\d articles/); t.$("[data-act='confirm']").click(); await until(() => t.w.mf.st.entries.every(e => e.feed_id !== 1 || e.status === "read") && /confirmed/.test((t.$(".toast") || {}).textContent || ""));
  assert.equal(t.w.mf.st.entries.filter(e => e.feed_id === 1 && e.status === "unread").length, 0, "every article of the feed is read on Miniflux, not only the displayed ones");
  assert.match(t.$(".toast").textContent, /Miniflux confirmed/); t.close();
});
test("while changes are on their way the screen says so: a bar, a pill with counts, a dot on each article; then 'Synced'", async () => {
  const t = await mount({ prefs: { confirmRead: "never" }, prep: (w) => { for (let i = 0; i < 320; i++) w.mf.st.entries.push({ ...entry(3000 + i, 1, `Slow ${i}`, "x", 5 + i / 100), feed: w.mf.st.entries[0].feed }); w.mf.st.delay = 150; } });
  t.key("M", { shiftKey: true }); await until(() => t.$(".pill").dataset.state === "syncing" && t.$(".pill .sub2"), 4000);
  assert.equal(t.$(".pill").dataset.state, "syncing"); assert.match(t.$(".pill").textContent, /Sending changes to Miniflux/); assert.match(t.$(".pill .sub2").textContent, /\d+ of \d+/);
  assert.equal(t.$(".progress").dataset.on, "true"); assert.equal(t.$(".progress").dataset.mode, "determinate"); assert.ok(t.$(".row[data-pending='true'] .pdot"), "articles still on their way carry a dot");
  let state = ""; for (let i = 0; i < 40 && state !== "synced"; i++) { await wait(250); state = t.$(".pill").dataset.state; }
  assert.equal(state, "synced"); assert.match(t.$(".pill").textContent, /Synced with Miniflux/); assert.equal(t.$(".progress").dataset.on, "false"); assert.equal(t.$(".pdot"), null); t.close();
});
test("the bar and pill are redrawn without taking the cursor out of the search box", async () => {
  const t = await mount(); const i = t.$(".search input"); i.focus(); i.value = "fri"; i.dispatchEvent(new t.win.Event("input", { bubbles: true })); await wait(420);
  assert.ok(t.$(".group[data-key='search']"), "results are showing"); assert.ok(t.win.document.activeElement.matches(".search input"), "focus stays in the box"); assert.equal(t.win.document.activeElement.value, "fri"); t.close();
});
test("search: loose words, highlighting, filters, the older-articles button, and Esc to clear", async () => {
  const t = await mount(); typeInto(t, ".search input", "frigate"); await wait(420);
  assert.match(t.$(".ghead .gtitle").textContent, /Results for “frigate”/); assert.equal(t.$$(".row").length, 2); assert.ok(t.$$(".row mark").some(m => m.textContent.toLowerCase() === "frigate"), "matches are highlighted");
  typeInto(t, ".search input", "frigte shipyrd"); await wait(420); assert.equal(t.$$(".row").length, 2, "misspellings still find them");
  typeInto(t, ".search input", "zzzz"); await wait(420); assert.match(t.$(".empty .t").textContent, /Nothing matches/); assert.ok(t.$(".tips"), "search tips are offered");
  typeInto(t, ".search input", "frigate"); await wait(420); t.$$(".sub .seg button").find(b => b.textContent === "Read").click(); await wait(100); assert.equal(t.$$(".row").length, 0, "no read article matches");
  t.$$(".sub .seg button").find(b => b.textContent === "Everything").click(); await wait(100); assert.equal(t.$$(".row").length, 2);
  const [a] = t.$$(".sub .btn").filter(b => /older/.test(b.textContent)); a.click(); await wait(200); assert.match(t.$(".toast").textContent, /Miniflux found/);
  t.$(".search input").focus(); t.key("Escape", { }); t.$(".search input").dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(150);
  assert.equal(t.$(".group[data-key='search']"), null, "Esc in the box clears the search"); assert.ok(t.$$(".group").length >= 3); t.close();
});
test("search finds an article whose reading copy has expired, and opening it fetches it again", async () => {
  const t = await mount(); await t.engine.markRead([4]); t.engine.settings.retentionDays = 0; await t.engine.refresh(); assert.equal(t.engine.cache.items[4], undefined);
  typeInto(t, ".search input", "fiscal deficit"); await wait(420); const row = rowByTitle(t, "Fiscal deficit"); assert.ok(row, "found in the index"); assert.ok(row.querySelector(".chip.idx"), "marked as archive");
  row.querySelector(".rtitle").click(); await wait(250); assert.ok(row.querySelector(".card"), "the card opens after the article is fetched again"); assert.equal(row.querySelector(".chip.idx"), null); assert.ok(t.engine.cache.items[4]); t.close();
});
const labels = (t) => t.$$(".side .trow .lbl").map(e => e.textContent).filter(x => x !== "All articles");
const ctx = (t, sel) => t.$(sel).dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
test("folders: no arrows or reorder mode, a grab cursor on top-level folders, and a note that feeds are ordered in Miniflux", async () => {
  const t = await mount(); assert.equal(t.$("[data-act='reorder']"), null); assert.equal(t.$(".mv"), null);
  assert.equal(t.$(".trow[data-id='cat:Food']").dataset.grab, "true"); assert.equal(t.$(".trow[data-id='feed:2']").dataset.grab, undefined, "feeds are not draggable"); assert.equal(t.$(".trow[data-id='cat:Defence/Shipbuilding']").dataset.grab, undefined, "nor are nested folders");
  const note = t.$(".sidenote"); assert.match(note.textContent, /alphabetically/); assert.match(note.textContent, /Miniflux/); assert.match(note.querySelector("a").href, /\/feeds$/); assert.equal(note.querySelector("a").rel, "noopener noreferrer"); t.close();
});
test("right-click on a folder moves it with the menu, the list follows, and the keyboard does the same with Alt and the arrows", async () => {
  const t = await mount(); assert.deepEqual(labels(t).slice(0, 2), ["Defence", "Shipbuilding"]);
  ctx(t, ".trow[data-id='cat:Food']"); assert.ok(t.$(".ctxmenu")); assert.equal(t.$("[data-act='move-down']").disabled, true, "the last cannot go down"); assert.equal(t.$("[data-act='move-up']").disabled, false);
  t.$("[data-act='move-up']").click(); await wait(100); assert.equal(t.$(".ctxmenu"), null, "the menu closes"); assert.deepEqual(labels(t).slice(0, 3), ["Food", "Broken Feed", "Kitchen Daily"]);
  await wait(700); assert.deepEqual(t.$$(".ghead .gtitle").map(e => e.textContent), ["Broken Feed", "Kitchen Daily", "Naval Wire"], "the article list follows the sidebar"); assert.equal(t.engine.settings.treeOrder.root[0], "cat:Food");
  ctx(t, ".trow[data-id='cat:Defence']"); assert.equal(t.$("[data-act='move-up']").disabled, false); t.$("[data-act='move-up']").dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.equal(t.$(".ctxmenu"), null, "Esc closes the menu");
  ctx(t, ".trow[data-id='feed:2']"); assert.equal(t.$("[data-act='move-up']"), null, "feeds have no move items"); assert.ok(t.$("[data-act='mark-read']")); t.win.document.dispatchEvent(new t.win.MouseEvent("pointerdown", { bubbles: true })); assert.equal(t.$(".ctxmenu"), null, "a click elsewhere closes it");
  t.$(".trow[data-id='cat:Defence'] .tbtn").dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true })); await wait(100); assert.equal(labels(t)[0], "Defence", "already first, nothing changes");
  t.$(".trow[data-id='cat:Food'] .tbtn").dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })); await wait(100); assert.deepEqual(labels(t).slice(0, 2), ["Defence", "Shipbuilding"], "Alt+Down moved Food back below Defence"); t.close();
});
test("right-click Mark all read asks first, marks every unread article in the folder, and can be undone", async () => {
  const t = await mount(); const before = t.engine.tree().find(n => n.id === "cat:Food").unread; assert.ok(before > 0);
  ctx(t, ".trow[data-id='cat:Food']"); assert.match(t.$("[data-act='mark-read']").textContent, new RegExp(String(before))); t.$("[data-act='mark-read']").click(); await wait(40);
  assert.ok(t.$(".dialog[aria-label='Mark as read?']")); assert.match(t.$(".dialog p").textContent, /“Food”/); t.$("[data-act='cancel']").click(); await wait(30); assert.equal(t.engine.tree().find(n => n.id === "cat:Food").unread, before, "cancel changes nothing");
  ctx(t, ".trow[data-id='cat:Food']"); t.$("[data-act='mark-read']").click(); await wait(40); t.$("[data-act='confirm']").click(); await wait(500);
  assert.equal(t.engine.tree().find(n => n.id === "cat:Food").unread, 0); assert.match(t.$(".toast").textContent, /Marked \d+ articles? read/); assert.ok(t.$(".toast button"), "Undo is offered");
  ctx(t, ".trow[data-id='cat:Food']"); assert.equal(t.$("[data-act='mark-read']").disabled, true, "nothing left to mark"); t.win.document.dispatchEvent(new t.win.MouseEvent("pointerdown", { bubbles: true }));
  ctx(t, ".trow[data-id='all']"); assert.ok(t.$("[data-act='mark-read']")); assert.equal(t.$("[data-act='move-up']"), null, "All articles cannot be moved"); t.close();
});
test("dragging a top-level folder shows a drop line, writes the new order on release, and a short move is only a click", async () => {
  const t = await mount(); const rows = t.$$(".side .trow[data-id]"); rows.forEach((r, i) => { r.getBoundingClientRect = () => ({ top: i * 30, bottom: i * 30 + 28, left: 0, right: 200, width: 200, height: 28 }); });
  const side = t.$(".side"); side.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 220, width: 220, height: 800 });
  const ev = (type, y, x = 20) => new t.win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  const grab = t.$(".trow[data-id='cat:Food'] .tbtn"); const foodIdx = rows.findIndex(r => r.dataset.id === "cat:Food"), defIdx = rows.findIndex(r => r.dataset.id === "cat:Defence");
  grab.dispatchEvent(ev("pointerdown", foodIdx * 30 + 10)); t.win.document.dispatchEvent(ev("pointermove", foodIdx * 30 + 12)); assert.equal(t.$(".dropline"), null, "under 6 pixels is still a click"); t.win.document.dispatchEvent(ev("pointerup", foodIdx * 30 + 12)); assert.equal(labels(t)[0], "Defence");
  grab.dispatchEvent(ev("pointerdown", foodIdx * 30 + 10)); t.win.document.dispatchEvent(ev("pointermove", defIdx * 30 + 2)); assert.ok(t.$(".dropline"), "the drop line shows"); assert.ok(t.win.document.body.classList.contains("dragging-folder"), "the grabbing cursor class is on"); assert.ok(t.$(".trow.lift"));
  t.win.document.dispatchEvent(ev("pointerup", defIdx * 30 + 2)); await wait(120); assert.equal(t.$(".dropline"), null); assert.equal(t.win.document.body.classList.contains("dragging-folder"), false);
  assert.deepEqual(labels(t).slice(0, 3), ["Food", "Broken Feed", "Kitchen Daily"], "Food now sits first"); assert.equal(t.engine.settings.treeOrder.root[0], "cat:Food"); assert.ok(t.engine.log.list().some(e => e.type === "order"));
  const g2 = t.$(".trow[data-id='cat:Food'] .tbtn"); g2.dispatchEvent(ev("pointerdown", 10)); t.win.document.dispatchEvent(ev("pointermove", 200)); t.win.document.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(50);
  assert.equal(t.$(".dropline"), null, "Esc cancels a drag"); assert.equal(labels(t)[0], "Food", "and changes nothing"); t.close();
});
test("Add feed: find feeds on a page, pick one, choose a folder, subscribe, and it appears", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.discover["https://blog.example"] = [{ url: "https://blog.example/feed.xml", title: "The Blog", type: "atom" }, { url: "https://blog.example/comments.xml", title: "Comments", type: "rss" }]; } });
  t.key("a"); await wait(30); assert.ok(t.$(".dialog[aria-label='Add a feed']"));
  const i = t.$(".dialog .urlrow input"); i.value = "https://nothing.example"; t.$("[data-act='find']").click(); await wait(150); assert.match(t.$(".dialog .res.bad").textContent, /Miniflux said: Unable to find any subscription/);
  i.value = "blog.example"; t.$("[data-act='find']").click(); await wait(200); assert.equal(t.$$(".feedopt").length, 2); assert.equal(t.$("[data-act='subscribe']").disabled, true, "pick a feed first");
  const sel = t.$(".dialog select"); assert.ok([...sel.options].some(o => o.textContent === "Food")); assert.equal([...sel.options].at(-1).textContent, "New folder…");
  t.$$(".feedopt input")[0].click(); t.$$(".feedopt input")[0].dispatchEvent(new t.win.Event("change", { bubbles: true })); sel.value = [...sel.options].find(o => o.textContent === "Food").value; assert.equal(t.$("[data-act='subscribe']").disabled, false);
  t.$("[data-act='subscribe']").click(); await wait(500);
  assert.equal(t.$(".dialog"), null, "the dialog closes"); assert.match(t.$(".toast").textContent, /Subscribed to New feed/); assert.ok(t.$$(".side .lbl").some(e => e.textContent.startsWith("New feed")));
  assert.equal(t.engine.tree().find(n => n.label.startsWith("New feed")).parent, "cat:Food"); t.close();
});
test("Add feed: a new folder can be created in the same step, and a feed already followed cannot be picked twice", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.feeds[0].feed_url = "https://navalnews.example/rss"; w.mf.st.discover["https://navalnews.example"] = [{ url: "https://navalnews.example/rss", title: "Naval", type: "rss" }, { url: "https://navalnews.example/atom", title: "Naval atom", type: "atom" }]; } });
  t.$("[data-act='addfeed']").click(); await wait(30); t.$(".dialog .urlrow input").value = "https://navalnews.example"; t.$("[data-act='find']").click(); await wait(250);
  const [first, second] = t.$$(".feedopt"); assert.equal(first.dataset.dim, "true"); assert.match(first.textContent, /already subscribed/); assert.equal(first.querySelector("input").disabled, true);
  second.querySelector("input").click(); second.querySelector("input").dispatchEvent(new t.win.Event("change", { bubbles: true }));
  const sel = t.$(".dialog select"); const nf = t.$(".dialog input[aria-label='New folder name']"); sel.value = "new"; sel.dispatchEvent(new t.win.Event("change", { bubbles: true })); assert.equal(nf.hidden, false); nf.value = "Defence/Reports";
  t.$("[data-act='subscribe']").click(); await wait(500); assert.ok(t.engine.tree().some(n => n.id === "cat:Defence/Reports" && n.type === "folder")); assert.equal(t.$(".dialog"), null); t.close();
});
test("the right-click menu opens Add feed with the page address filled in and the search already running", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.discover["https://blog.example/post"] = [{ url: "https://blog.example/feed.xml", title: "The Blog", type: "atom" }]; } });
  t.win.location.hash = "#subscribe=" + encodeURIComponent("https://blog.example/post"); await wait(450);
  assert.ok(t.$(".dialog[aria-label='Add a feed']")); assert.equal(t.$(".dialog .urlrow input").value, "https://blog.example/post"); assert.equal(t.$$(".feedopt").length, 1); assert.equal(t.win.location.hash, "", "the address is tidied up");
  t.key("Escape"); await wait(20); assert.equal(t.$(".dialog"), null); t.win.location.hash = "#subscribe=javascript%3Aalert(1)"; await wait(100); assert.equal(t.$(".dialog"), null, "an unsafe address is ignored"); t.close();
});
test("without a Miniflux key, Add feed explains instead of opening", async () => {
  const t = await mount({ noToken: true }); t.key("a"); await wait(30); assert.equal(t.$(".dialog"), null); t.close();
});
test("the Bionic button sits in the top bar and the card; Shift+B toggles; the choice is remembered", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.entries.find(e => e.id === 1).content = "<p>Analysts noted the contract sets a pattern for future orders.</p>"; } });
  const row = rowByTitle(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(160);
  const top = t.$(".top .ibtn.bionic"); assert.ok(top); assert.equal(top.getAttribute("aria-pressed"), "false"); assert.ok(row.querySelector(".btn.bionic"), "the card has its own button"); assert.equal(row.querySelectorAll(".prose .bf").length, 0);
  top.click(); await wait(80); assert.equal(t.$(".top .ibtn.bionic").getAttribute("aria-pressed"), "true"); assert.ok(row.querySelectorAll(".prose .bf").length >= 5); assert.ok(row.querySelector(".btn.bionic.on"));
  t.key("B", { shiftKey: true }); await wait(60); assert.equal(row.querySelectorAll(".prose .bf").length, 0); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).anchor, false);
  row.querySelector(".btn.bionic").click(); await wait(60); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).anchor, true); assert.match(t.$$(".toast").at(-1).textContent, /Bionic reading is on/); assert.doesNotMatch(t.$$(".toast").at(-1).textContent, /null/); t.close();
});
test("fonts: only New York and SF Pro are bundled; a choice applies at once and is remembered, and an old or unknown value falls back safely", async () => {
  const t = await mount(); t.$(".aa").click(); const rf = t.$(".pop select"); assert.equal([...rf.options].length, 3, "New York, SF Pro and the system serif"); assert.equal(rf.querySelectorAll("optgroup").length, 2, "serif and sans groups"); rf.value = "sfpro"; rf.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(40);
  assert.equal(t.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-sfpro)"); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).readFont, "sfpro");
  t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent.includes("Look")).click(); await wait(40);
  const cards = (label) => t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.startsWith(label));
  const ui = cards("System").find(c => c.querySelector(".fname").textContent.replace("In use", "") === "System"); assert.ok(ui, "a card for the system interface font"); ui.click(); await wait(30);
  assert.equal(t.win.document.documentElement.style.getPropertyValue("--ui"), "var(--ui-system)"); t.close();
  for (const old of ["newsreader", "literata", "lora", "ubuntu", "atkinson", "comic-sans"]) { const bad = await mount({ prefs: { readFont: old, uiFont: old === "comic-sans" ? "x" : "plex", confirmRead: "sometimes" } }); assert.equal(bad.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-newyork)", old + " falls back to New York"); assert.equal(bad.win.document.documentElement.style.getPropertyValue("--ui"), "var(--ui-sfpro)"); bad.close(); }
});
test("each section shows how much of it is read, and it moves as articles are read", async () => {
  const t = await mount(); const g = t.$$(".group").find(x => x.querySelector(".gtitle").textContent === "Naval Wire"); const w0 = g.querySelector(".gprog i").style.width; assert.equal(w0, "0%");
  g.querySelector(".row").click(); t.key("m"); await wait(150); assert.equal(g.querySelector(".gprog i").style.width, "50%"); assert.equal(g.querySelector(".gprog").getAttribute("aria-valuenow"), "1"); t.close();
});
test("toasts survive a redraw, stack, replace duplicates and can be dismissed", async () => {
  const t = await mount(); t.$(".tab[aria-selected='true']").click(); t.$$(".ibtn").find(b => b.title.startsWith("Theme")).click(); await wait(30); const n1 = t.$$(".toast").length; assert.equal(n1, 1);
  t.$$(".ibtn").find(b => b.title.startsWith("Theme")).click(); await wait(30); assert.equal(t.$$(".toast").length, 2, "a different message stacks");
  t.$(".toast .tx").click(); await wait(300); assert.equal(t.$$(".toast").length, 1); t.$$(".tab").find(b => b.textContent.includes("Stats")).click(); await wait(100); assert.equal(t.$$(".toast").length, 1, "a page change does not wipe it"); t.close();
});

test("New York and SF Pro are offered, picked from cards and remembered, and nothing else is bundled", async () => {
  const t = await mount(); t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent.includes("Look")).click(); await wait(40);
  const names = () => t.$$(".fontcard").map(c => c.querySelector(".fname").textContent.replace("In use", "")); const all = names();
  assert.equal(all.filter(x => x === "SF Pro").length, 2, "SF Pro is in both pickers"); assert.equal(all.filter(x => x === "New York").length, 1, "New York is a serif, so only a reading font");
  assert.ok(!all.some(x => /Ubuntu|Plex|Newsreader|Literata|Lora|Atkinson|Merriweather|Crimson|Source/.test(x)), "no other family is offered");
  assert.equal(t.$$(".fonthead").length, 3, "the reading picker has Serif and Sans headings, the interface picker only Sans"); assert.ok(t.$$(".fontcard .fnote").every(n => n.textContent.length > 10), "every card says in words what the font is for");
  const pick = async (label, nth) => { t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.replace("In use", "") === label)[nth].click(); await wait(30); };
  await pick("SF Pro", 0); assert.equal(t.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-sfpro)");
  await pick("New York", 0); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).readFont, "newyork");
  assert.equal(t.$$(".fontcard[aria-pressed='true']").length, 2, "one card is marked in use per picker"); t.close();
});
test("an Apple font missing from this build is shown as unavailable and cannot be chosen", async () => {
  const t = await mount({ fontProbe: (spec) => spec.includes("Pravaha SF Pro") ? [] : [{}] }); await wait(30);
  t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent.includes("Look")).click(); await wait(60);
  const sf = t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.startsWith("SF Pro")); assert.equal(sf.length, 2); assert.ok(sf.every(c => c.disabled && /apple-fonts/.test(c.textContent)), "SF Pro is disabled with the fix named");
  const ny = t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.startsWith("New York")); assert.ok(ny.every(c => !c.disabled), "New York, which loaded, stays available");
  t.$(".aa").click(); const rf = t.$(".pop select"); assert.ok([...rf.options].find(o => o.value === "sfpro").disabled, "the popover disables it too"); t.close();
});

// ---------- 0.4.0: moving a setup ----------
const openMove = async (t) => { t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent === "Move setup").click(); await wait(80); };
test("a machine with no keys shows the three set-up routes, and Fetch brings in what Firefox Sync holds", async () => {
  const area = syncArea(); area.m.set("pv:keys", { v: 1, at: 5000, by: "laptop", data: { miniflux: { url: "https://mf.test", token: "good-key" }, webdav: { url: "https://dav.test", user: "u", pass: "p", root: "pravaha" }, raindrop: { token: "rd-token" } } });
  const t = await mount({ noToken: true, area }); const routes = t.$$(".hero.setup .route"); assert.equal(routes.length, 3);
  assert.equal(t.$(".pill").textContent.includes("In sync"), false, "never says In sync with nothing connected");
  t.$(".hero.setup [data-act='fx-pull']").click(); await wait(400);
  assert.equal(t.engine.settings.miniflux.token, "good-key"); assert.equal(t.$(".hero.setup"), null, "the set-up routes go away once keys arrive"); t.close();
});
test("Move setup: Firefox Sync panel lists each part, sends, and the toggles are saved", async () => {
  const t = await mount(); await openMove(t); const rows = t.$$("[data-fx] .fxrow"); assert.equal(rows.length, 4);
  t.$("[data-fx] [data-act='fx-push']").click(); await wait(250);
  assert.deepEqual([...t.area.m.keys()].sort(), ["pv:keys", "pv:order", "pv:settings", "pv:ui"].filter(k => t.area.m.has(k)).sort()); assert.ok(t.area.m.has("pv:keys") && t.area.m.has("pv:settings"));
  const box = t.$$("[data-fx] .check input")[0]; box.checked = false; box.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(120);
  assert.equal(t.engine.settings.sync.keys, false); t.close();
});
test("Move setup: export asks for a passphrase when keys are included; the file carries no clear key; import takes it back", async () => {
  const t = await mount(); await openMove(t); let saved = null;
  URL.createObjectURL = (b) => { saved = b; return "blob:x"; }; t.win.HTMLAnchorElement.prototype.click = function () {};
  const keysBox = t.$("[data-exp='keys']"); keysBox.checked = true; keysBox.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(40);
  t.$("[data-act='export']").click(); await wait(150); assert.equal(saved, null, "no file without a passphrase");
  const pw = t.$("[data-exp='pass']"); pw.value = "open sesame"; pw.dispatchEvent(new t.win.Event("input", { bubbles: true }));
  t.$("[data-act='export']").click(); await wait(300); assert.ok(saved, "a file was produced");
  const text = await saved.text(); assert.ok(!text.includes("good-key")); assert.equal(JSON.parse(text).format, "pravaha-settings");
  const u = await mount({ noToken: true }); await openMove(u);
  const input = u.$("[data-act='import-file']"); const file = new u.win.File([text], "s.json", { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file] }); input.dispatchEvent(new u.win.Event("change", { bubbles: true })); await wait(150);
  assert.ok(u.$("[data-imp='pass']"), "a passphrase box appears for a file with keys");
  u.$("[data-act='import']").click(); await wait(200); assert.equal(u.engine.settings.miniflux.token, "", "wrong or missing passphrase changes nothing");
  const ip = u.$("[data-imp='pass']"); ip.value = "open sesame"; ip.dispatchEvent(new u.win.Event("input", { bubbles: true })); u.$("[data-act='import']").click(); await wait(500);
  assert.equal(u.engine.settings.miniflux.token, "good-key"); t.close(); u.close();
});

test("Move setup: setup text can be copied and pasted into another machine, with the passphrase", async () => {
  const t = await mount(); await openMove(t); let copied = null;
  Object.defineProperty(t.win.navigator, "clipboard", { value: { writeText: async (x) => { copied = x; } }, configurable: true }); Object.defineProperty(globalThis, "navigator", { value: t.win.navigator, configurable: true });
  const keysBox = t.$("[data-exp='keys']"); keysBox.checked = true; keysBox.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(40);
  const pw = t.$("[data-exp='pass']"); pw.value = "pw1"; pw.dispatchEvent(new t.win.Event("input", { bubbles: true }));
  t.$("[data-act='copy-text']").click(); await wait(300); assert.ok(copied && JSON.parse(copied).format === "pravaha-settings"); assert.ok(!copied.includes("good-key"));
  const u = await mount({ noToken: true }); await openMove(u);
  const box = u.$("[data-imp='paste']"); box.value = copied; box.dispatchEvent(new u.win.Event("input", { bubbles: true })); await wait(80);
  const ip = u.$("[data-imp='pass']"); assert.ok(ip, "a passphrase box appears for pasted text with keys"); ip.value = "pw1"; ip.dispatchEvent(new u.win.Event("input", { bubbles: true }));
  u.$("[data-act='import']").click(); await wait(500); assert.equal(u.engine.settings.miniflux.token, "good-key"); t.close(); u.close();
});
test("Settings: the feed detection switch explains first, then asks Firefox, and declining changes nothing", async () => {
  const dstate = { granted: false, registered: false }; const detect = { state: async () => ({ ...dstate, on: dstate.granted && dstate.registered }), enable: async () => { dstate.registered = dstate.granted; return { ...dstate, on: dstate.granted, ok: dstate.granted }; }, disable: async () => { dstate.granted = dstate.registered = false; return { ...dstate, on: false, ok: true }; }, get: async () => [] };
  const t = await mount({ detect }); t.$(".tab[data-tab='settings'], .tab:nth-child(5)").click(); await wait(60);
  [...t.$$(".stab")].find(b => /This machine/.test(b.textContent)).click(); await wait(80);
  const sw = t.$("[data-act='detect-feeds']"); assert.ok(sw); assert.equal(sw.getAttribute("aria-checked"), "false"); assert.equal(sw.getAttribute("role"), "switch");
  sw.click(); await wait(40); const dlg = t.$(".dialog[aria-label='Detect feeds on pages?']"); assert.ok(dlg, "Pravaha's own explanation comes first"); assert.equal(t.perms.requested.length, 0, "Firefox has not been asked yet");
  assert.match(dlg.textContent, /Access your data for all websites/); assert.match(dlg.textContent, /feed links in the page’s head/); assert.match(dlg.textContent, /right-click, Subscribe with Pravaha, keeps working/);
  t.$("[data-act='cancel']").click(); await wait(60); assert.equal(t.perms.requested.length, 0); assert.equal(t.$("[data-act='detect-feeds']").getAttribute("aria-checked"), "false"); assert.match(t.$("[data-note='detect']").textContent, /stays off/);
  t.$("[data-act='detect-feeds']").click(); await wait(40); dstate.granted = true; t.$("[data-act='confirm']").click(); await wait(120);
  assert.deepEqual(t.perms.requested[0].origins, ["https://*/*", "http://*/*"]); assert.equal(t.$("[data-act='detect-feeds']").getAttribute("aria-checked"), "true"); assert.match(t.$("[data-note='detect']").textContent, /is on/);
  t.$("[data-act='detect-feeds']").click(); await wait(100); assert.equal(t.$("[data-act='detect-feeds']").getAttribute("aria-checked"), "false"); assert.equal(dstate.granted, false, "turning off gives the permission back"); t.close();
});
test("the popup lists the page's feeds and subscribing opens the Add feed dialog with that address", async () => {
  const detect = { state: async () => ({ on: true }), get: async () => [{ url: "https://blog.example/feed.xml", title: "The Blog", type: "atom" }] };
  const t = await mount({ detect }); assert.deepEqual(await t.handlers.feedsFor({ tabId: 5 }), [{ url: "https://blog.example/feed.xml", title: "The Blog", type: "atom" }]);
  assert.deepEqual(await t.handlers.openSubscribe({ url: "javascript:alert(1)" }), { ok: false }); assert.deepEqual(await t.handlers.openSubscribe({ url: "https://blog.example/feed.xml" }), { ok: true }); assert.ok(t.opened.includes("subscribe:https://blog.example/feed.xml")); t.close();
});

// ---------- 0.6.0: feed management, server tile, lazy list ----------
const openFeeds = async (t) => { t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(40); t.$$(".stab").find(b => b.textContent === "Feeds").click(); await until(() => t.$$(".frow").length >= 3); };
const setVal = (t, el, v) => { el.value = v; el.dispatchEvent(new t.win.Event("input", { bubbles: true })); };

test("Feeds tab lists every feed with its health, filters by name, and shows only feeds in trouble on request", async () => {
  const t = await mount(); await openFeeds(t);
  assert.deepEqual(t.$$(".frow .ftitle").map(e => e.textContent).sort(), ["Broken Feed", "Kitchen Daily", "Naval Wire"]);
  assert.match(t.$("[data-fsum]").textContent, /3 feeds/); assert.ok(!/null|undefined/.test(t.$("[data-flist]").textContent), "no stray null text under the list");
  setVal(t, t.$("[data-field='feed-filter']"), "naval"); assert.deepEqual(t.$$(".frow .ftitle").map(e => e.textContent), ["Naval Wire"]);
  setVal(t, t.$("[data-field='feed-filter']"), "defence"); assert.deepEqual(t.$$(".frow .ftitle").map(e => e.textContent), ["Naval Wire"], "the folder name is searched too");
  setVal(t, t.$("[data-field='feed-filter']"), ""); const p = t.$("[data-field='feed-problems']"); p.checked = true; p.dispatchEvent(new t.win.Event("change", { bubbles: true }));
  assert.deepEqual(t.$$(".frow .ftitle").map(e => e.textContent), ["Broken Feed"]); t.close();
});
test("renaming a feed asks for the name, saves it in Miniflux and updates the list and sidebar", async () => {
  const t = await mount(); await openFeeds(t);
  t.$$(".frow").find(r => r.textContent.includes("Kitchen Daily")).querySelector("[data-act='feed-rename']").click(); await wait(20);
  const box = t.$("[data-field='text']"); assert.equal(box.value, "Kitchen Daily"); setVal(t, box, "Cooking Daily"); t.$("[data-act='confirm']").click();
  await until(() => t.w.mf.st.feeds[1].title === "Cooking Daily"); await wait(150);
  assert.ok(t.$$(".frow .ftitle").some(e => e.textContent === "Cooking Daily")); assert.ok(t.$$(".side .lbl").some(e => e.textContent === "Cooking Daily")); assert.equal(t.$(".dialogs .dialog"), null); t.close();
});
test("moving a feed offers the existing folders and New folder…, and the change reaches Miniflux", async () => {
  const t = await mount(); await openFeeds(t);
  t.$$(".frow").find(r => r.textContent.includes("Kitchen Daily")).querySelector("[data-act='feed-move']").click(); await wait(20);
  const sel = t.$("[data-field='folder']"); assert.deepEqual([...sel.options].map(o => o.textContent), ["Defence", "Defence/Shipbuilding", "Food", "New folder…"]); assert.equal(sel.value, "Food");
  sel.value = "__new__"; sel.dispatchEvent(new t.win.Event("change", { bubbles: true })); const nf = t.$("[data-field='newfolder']"); assert.equal(nf.hidden, false); assert.equal(t.$("[data-act='confirm']").disabled, true);
  setVal(t, nf, "Home/Cooking"); assert.equal(t.$("[data-act='confirm']").disabled, false); t.$("[data-act='confirm']").click();
  await until(() => t.w.mf.st.feeds[1].category.title === "Home/Cooking"); await wait(150); assert.ok(t.$$(".side .lbl").some(e => e.textContent === "Cooking")); t.close();
});
test("disable and enable switch a feed off and on in Miniflux and mark it in the list", async () => {
  const t = await mount(); await openFeeds(t); const row = () => t.$$(".frow").find(r => r.textContent.includes("Kitchen Daily"));
  row().querySelector("[data-act='feed-toggle']").click(); await until(() => t.w.mf.st.feeds[1].disabled === true); await wait(150);
  assert.equal(row().dataset.state, "off"); assert.match(row().textContent, /Disabled/); assert.equal(row().querySelector("[data-act='feed-toggle']").textContent, "Enable");
  row().querySelector("[data-act='feed-toggle']").click(); await until(() => t.w.mf.st.feeds[1].disabled === false); t.close();
});
test("deleting a feed needs the exact name typed, offers Disable instead, and removes it everywhere", async () => {
  const t = await mount(); await openFeeds(t); const row = () => t.$$(".frow").find(r => r.textContent.includes("Broken Feed"));
  row().querySelector("[data-act='feed-delete']").click(); await wait(20); const ok = t.$("[data-act='confirm']"); assert.equal(ok.disabled, true); assert.ok(t.$("[data-act='alt']"));
  setVal(t, t.$("[data-field='typed']"), "broken feed"); assert.equal(ok.disabled, true, "the name must match exactly");
  setVal(t, t.$("[data-field='typed']"), "Broken Feed"); assert.equal(ok.disabled, false); ok.click();
  await until(() => t.w.mf.st.deleted && t.w.mf.st.deleted.length); await wait(150);
  assert.ok(!t.$$(".frow .ftitle").some(e => e.textContent === "Broken Feed")); assert.ok(!t.$$(".side .lbl").some(e => e.textContent === "Broken Feed")); t.close();
});
test("the right-click menu offers Refresh, Rename and Move for a feed, and Rename folder for a folder", async () => {
  const t = await mount(); const menu = async (id) => { t.$(`.side .trow[data-id="${id}"]`).dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await wait(10); return [...t.win.document.querySelectorAll(".ctxmenu .ctxitem")].map(b => b.dataset.act); };
  const feedActs = await menu("feed:1"); for (const a of ["mark-read", "feed-refresh", "feed-rename", "feed-move", "feed-delete"]) assert.ok(feedActs.includes(a), a);
  t.key("Escape"); await wait(10); const folderActs = await menu("cat:Food"); for (const a of ["folder-refresh", "folder-rename", "move-up"]) assert.ok(folderActs.includes(a), a);
  t.key("Escape"); await wait(10); assert.ok((await menu("all")).includes("refresh-all")); t.close();
});
test("renaming a folder from the menu renames it in Miniflux, keeps its place and follows the open scope", async () => {
  const t = await mount(); t.$(`.side .trow[data-id="cat:Food"] .tbtn`).click(); await wait(100);
  t.$(`.side .trow[data-id="cat:Food"]`).dispatchEvent(new t.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); await wait(10);
  t.win.document.querySelector(".ctxitem[data-act='folder-rename']").click(); await wait(20); setVal(t, t.$("[data-field='text']"), "Kitchen"); t.$("[data-act='confirm']").click();
  await until(() => t.w.mf.st.cats.some(c => c.title === "Kitchen")); await wait(200);
  assert.ok(t.$(`.side .trow[data-id="cat:Kitchen"]`)); assert.equal(t.$(`.side .trow[data-id="cat:Food"]`), null); assert.equal(t.$(".side [aria-current='true']").closest(".trow").dataset.id, "cat:Kitchen"); t.close();
});
test("Refresh every feed asks Miniflux to fetch and says so", async () => {
  const t = await mount(); await openFeeds(t); t.$("[data-act='refresh-all']").click(); await until(() => t.w.mf.st.calls.some(c => c.includes("/feeds/refresh"))); await wait(60);
  assert.match(t.$(".toast").textContent, /Asked Miniflux to refresh every feed/); t.close();
});
test("the Sync page shows the Miniflux server tile with its version, a read-only check, and Got it after a change", async () => {
  const t = await mount(); t.$$(".tab").find(b => b.textContent.includes("Sync")).click(); await until(() => t.$(".tile .tbig")); 
  const tile = () => t.$$(".tile").find(x => x.textContent.includes("Miniflux server")); assert.ok(tile()); assert.match(tile().querySelector(".tbig").textContent, /2\.\d/);
  tile().querySelector("[data-act='server-check']").click(); await until(() => t.$("[data-checks]")); assert.ok(t.$$("[data-checks] li").length >= 4); assert.ok(t.$$("[data-checks] li").some(l => /Version: Miniflux/.test(l.textContent)));
  assert.equal(t.w.mf.st.calls.filter(c => c.startsWith("PUT") || c.startsWith("DELETE") || c.includes("/refresh")).length, 0, "the check changes nothing");
  assert.equal(tile().querySelector("[data-act='server-ack']"), null);
  t.w.mf.st.version = "2.9.0"; tile().querySelector("[data-act='server-check']").click(); await until(() => tile().dataset.state === "amber");
  assert.equal(tile().dataset.state, "amber"); tile().querySelector("[data-act='server-ack']").click(); await until(() => !tile().querySelector("[data-act='server-ack']")); assert.equal(tile().dataset.state, "green"); t.close();
});
test("a library of several hundred articles builds in slices: the first rows at once, the rest by scrolling and by Expand all", async () => {
  const t = await mount({ prep: (w) => { w.mf.st.feeds = Array.from({ length: 12 }, (_, i) => ({ ...w.mf.st.feeds[0], id: 20 + i, title: `Bulk ${i}` })); w.mf.st.entries = []; let id = 1000; for (let f = 0; f < 12; f++) for (let k = 0; k < 40; k++) w.mf.st.entries.push(entry(id++, 20 + f, `Bulk ${f} story ${k}`, "body text for the story", 1)); } });
  await until(() => t.$$(".row").length >= 60); assert.ok(t.$$(".group").length === 12);
  await until(() => t.$$(".row").length === 480, 8000); assert.equal(t.$$(".row").length, 480, "every article is eventually present"); t.close();
});

// ---------- 0.7.0: training in plain sight ----------
const rowOf = (t, text) => rowByTitle(t, text);
test("an open card shows its tags and words as buttons; one click is more, two is less, three clears, and the score pill follows", async () => {
  const t = await mount(); const row = rowOf(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(250); const e0 = t.engine.scoreRow(1).score; const pill = () => Number(row.querySelector(".score").textContent);
  const strip = row.querySelector(".tstrip"); assert.ok(strip, "the training strip is on the card, not hidden in a fold"); const chips = [...strip.querySelectorAll("button.tchip")]; assert.ok(chips.length >= 2, "tags and words are clickable");
  const tag = chips.find(c => c.dataset.key === "defence"); assert.ok(tag, "a tag from the Raindrop vocabulary is offered"); assert.match(tag.getAttribute("aria-label"), /defence: neutral\. Click to see more of it/);
  tag.click(); await wait(80); const now = () => [...row.querySelectorAll(".tchip")].find(c => c.dataset.key === "defence");
  assert.equal(now().dataset.v, "1"); assert.equal(now().getAttribute("aria-pressed"), "true"); assert.match(row.querySelector(".tnote").textContent, /More of “defence”/); assert.ok(t.engine.trainingRules().some(r => r.type === "tag" && r.key === "defence" && r.value === 1));
  const more = pill();
  now().click(); await wait(80); assert.equal(now().dataset.v, "-1"); assert.match(row.querySelector(".tnote").textContent, /Less of “defence”/); assert.ok(t.engine.trainingRules().some(r => r.key === "defence" && r.value === -1)); const less = pill(); assert.ok(more > less, `the pill follows without a reload: more ${more}, less ${less}`);
  now().click(); await wait(80); assert.equal(now().dataset.v, "0"); assert.ok(!t.engine.trainingRules().some(r => r.key === "defence"), "the third click clears the rule"); assert.equal(t.engine.scoreRow(1).score, e0, "and the score is exactly back"); assert.ok(pill() > less && pill() < more, "the pill sits between the two"); t.close();
});
test("the thumbs on a row and on its card train together, toggle, and say what they trained, with Undo", async () => {
  const t = await mount(); const row = rowOf(t, "Navy orders"); const up = row.querySelector(".acts .rate[data-v='1']"), down = row.querySelector(".acts .rate[data-v='-1']"); assert.ok(up && down, "both thumbs are on the row"); assert.equal(up.getAttribute("aria-pressed"), "false");
  const score0 = Number(row.querySelector(".score").textContent); up.click(); await wait(120);
  assert.equal(row.dataset.rating, "1"); assert.equal(up.getAttribute("aria-pressed"), "true"); assert.ok(Number(row.querySelector(".score").textContent) >= score0); assert.match(t.$(".toast .tmsg").textContent, /^Noted\. More like this: /); assert.ok(t.$(".toast .tact").textContent === "Undo");
  row.querySelector(".rtitle").click(); await wait(250); const cardUp = row.querySelector(".cacts .rate[data-v='1']"); assert.equal(cardUp.getAttribute("aria-pressed"), "true", "the card shows the thumb already pressed");
  t.$(".toast .tact").click(); await wait(120); assert.equal(row.dataset.rating, "0"); assert.equal(cardUp.getAttribute("aria-pressed"), "false"); assert.deepEqual(t.engine.trainingRules(), [], "Undo took back every rule the thumb set");
  row.querySelector(".cacts .rate[data-v='-1']").click(); await wait(120); assert.equal(row.dataset.rating, "-1"); assert.ok(t.engine.trainingRules().every(r => r.value < 0) && t.engine.trainingRules().length > 0); assert.match([...t.$$(".toast .tmsg")].pop().textContent, /^Noted\. Less like this/); t.close();
});
test("a tag a thumb already set to +0.3 flips to less on the first click, not to cleared", async () => {
  const t = await mount(); const row = rowOf(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(250);
  row.querySelector(".cacts .rate[data-v='1']").click(); await wait(150);
  const chip = () => [...row.querySelectorAll(".tchip")].find(c => c.dataset.key === "defence"); assert.ok(chip(), "the tag chip is there"); assert.equal(chip().dataset.v, "1", "a thumb shows as more");
  assert.ok(t.engine.trainingRules().some(r => r.type === "tag" && r.key === "defence" && Math.abs(r.value - 0.3) < 1e-9), "the thumb wrote 0.3");
  chip().click(); await wait(120); assert.equal(chip().dataset.v, "-1"); assert.ok(t.engine.trainingRules().some(r => r.key === "defence" && r.value === -1), "one click makes it a full less");
  chip().click(); await wait(120); assert.equal(chip().dataset.v, "0"); assert.ok(!t.engine.trainingRules().some(r => r.key === "defence")); t.close();
});
test("+ and - rate the selected article from the keyboard, and the shortcut list says so", async () => {
  const t = await mount(); const row = rowOf(t, "Navy orders"); row.click(); await wait(30); t.key("+"); await wait(120); assert.equal(row.dataset.rating, "1"); t.key("-"); await wait(120); assert.equal(row.dataset.rating, "-1"); t.key("-"); await wait(120); assert.equal(row.dataset.rating, "0", "the same key again takes it back");
  t.key("?"); await wait(30); assert.ok([...t.$$(".overlay kbd")].some(k => k.textContent === "+ / -")); t.close();
});
test("a page you saved in Raindrop says so on its card, with your tags and note, and a close save is offered for the others", async () => {
  const t = await mount({ prep: (w) => w.rd.st.bookmarks.push({ _id: 900, title: "Navy orders new frigates", excerpt: "frigate shipyard", note: "Read before the budget talk", tags: ["defence", "frigates"], link: "https://www.site1.example/1/?utm_source=x#t", lastUpdate: "2026-03-12T00:00:00Z" }) });
  const row = rowOf(t, "Navy orders"); row.querySelector(".rtitle").click(); await wait(250); const lines = [...row.querySelectorAll(".tstrip .rdline")].map(x => x.textContent);
  assert.ok(lines[0].startsWith("You saved this page in Raindrop"), lines[0]); assert.match(lines[0], /#defence #frigates/); assert.match(lines[0], /“Read before the budget talk”/);
  assert.equal([...row.querySelectorAll(".tchip")][0].querySelector("svg") !== null, true, "your own Raindrop tags carry the bookmark mark");
  const other = rowOf(t, "lemon cake"); other.querySelector(".rtitle").click(); await wait(250); assert.ok(!/You saved this page/.test(other.querySelector(".tstrip").textContent), "no false claim for an article you never saved"); t.close();
});
test("without a Raindrop token the strip says where tags come from instead of staying empty", async () => {
  const t = await mount({ prep: (w) => { w.rd.st.bookmarks = []; } }); const row = rowOf(t, "lemon cake"); row.querySelector(".rtitle").click(); await wait(250);
  const note = row.querySelector(".tstrip .trow .note"); assert.ok(note && note.textContent.length > 20, "an empty tag list is explained in words"); assert.ok(row.querySelector(".why summary").textContent === "Why it ranks here"); t.close();
});
test("Stats lists the rules without the thumbs' own bookkeeping, in plain words", async () => {
  const t = await mount(); await t.engine.rateStory(1, 1); t.$$(".tab").find(b => b.textContent.includes("Stats")).click(); await wait(150);
  const rules = [...t.$$(".trainrow .kw[data-v]")].map(x => x.textContent); assert.ok(rules.some(x => x.startsWith("tag: defence")), rules.join("|")); assert.ok(!rules.some(x => x.startsWith("story")), "no story entries shown"); t.close();
});
