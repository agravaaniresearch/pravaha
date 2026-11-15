// Drives the real reader screen inside jsdom, wired to the real engine and fake servers.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeHandlers } from "../extension/src/handlers.js";
import { world, settings, entry } from "./helpers.mjs";

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); } return !!fn(); };
let n = 0;
async function mount({ prep, noToken = false, prefs = null, fontProbe = null } = {}) {
  const w = await world(); if (prep) prep(w);
  const storage = new MemoryStorage(); await storage.set({ settings: settings("laptop", noToken ? { miniflux: { url: "https://mf.test", token: "" } } : {}) });
  const listeners = []; const opened = [];
  const engine = new Engine({ storage, fetchImpl: w.fetchImpl, onChange: () => listeners.forEach(f => f({ type: "changed" })) }); await engine.load(); if (!noToken) await engine.syncNow();
  const handlers = makeHandlers({ engine, fetchImpl: w.fetchImpl, runSync: () => engine.syncNow(), schedule: async () => {}, openTab: async (r) => { opened.push(r.url); }, saveSynced: async () => {} });
  const dom = new JSDOM('<!doctype html><html data-theme="auto"><body><div id="app"></div></body></html>', { url: "http://pravaha.test/ui/reader.html", pretendToBeVisual: true });
  const win = dom.window; win.HTMLElement.prototype.scrollIntoView = () => {}; win.matchMedia = () => ({ matches: false, addEventListener() {} }); if (fontProbe) win.document.fonts = { load: async (spec) => fontProbe(spec) };
  const ios = []; win.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.els = new Set(); ios.push(this); } observe(e) { this.els.add(e); } disconnect() { this.els.clear(); } };
  const defs = { window: win, document: win.document, localStorage: win.localStorage, navigator: win.navigator, location: win.location, history: win.history, getComputedStyle: win.getComputedStyle.bind(win), IntersectionObserver: win.IntersectionObserver, requestAnimationFrame: (f) => setTimeout(f, 0) };
  for (const [k, v] of Object.entries(defs)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  if (prefs) win.localStorage.setItem("pravaha.ui", JSON.stringify(prefs));
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
  tab("Settings"); await wait(60); for (const s of ["Look and reading", "Ranking", "This machine", "Shortcuts", "Connections"]) { t.$$(".stab").find(b => b.textContent === s).click(); assert.ok(t.$(".page .panel, .page .conns")); } t.close();
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
test("folders and feeds can be reordered from the sidebar and the article list follows", async () => {
  const t = await mount(); const order = () => t.$$(".side .trow .lbl").map(e => e.textContent).filter(x => x !== "All articles");
  assert.equal(t.$(".mv"), null, "no arrows until reorder mode"); t.$("[data-act='reorder']").click(); await wait(30); assert.ok(t.$(".mv")); assert.match(t.$(".toast").textContent, /Reorder mode/);
  assert.equal(t.$(".trow[data-id='cat:Defence'] [data-mv='up']").disabled, true, "the first cannot go up"); assert.equal(t.$(".trow[data-id='cat:Food'] [data-mv='down']").disabled, true);
  t.$(".trow[data-id='cat:Food'] [data-mv='up']").click(); await wait(100); assert.deepEqual(order().slice(0, 3), ["Food", "Broken Feed", "Kitchen Daily"]);
  await wait(700); assert.deepEqual(t.$$(".ghead .gtitle").map(e => e.textContent), ["Broken Feed", "Kitchen Daily", "Naval Wire"], "the list follows the sidebar");
  t.$("[data-act='reorder']").click(); await wait(30); assert.equal(t.$(".mv"), null); assert.equal(t.engine.settings.treeOrder.root[0], "cat:Food"); t.close();
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
test("more fonts: reading and interface fonts apply at once, are remembered, and an unknown value falls back safely", async () => {
  const t = await mount(); t.$(".aa").click(); const rf = t.$(".pop select"); assert.ok([...rf.options].length >= 11, "eleven reading fonts"); assert.equal(rf.querySelectorAll("optgroup").length, 2, "serif and sans groups"); rf.value = "lora"; rf.dispatchEvent(new t.win.Event("change", { bubbles: true })); await wait(40);
  assert.equal(t.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-lora)"); assert.equal(JSON.parse(t.win.localStorage.getItem("pravaha.ui")).readFont, "lora");
  t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent.includes("Look")).click(); await wait(40);
  const cards = (label) => t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.startsWith(label));
  const ui = cards("Source Sans")[0]; assert.ok(ui, "a card for the interface font"); ui.click(); await wait(30);
  assert.equal(t.win.document.documentElement.style.getPropertyValue("--ui"), "var(--ui-sourcesans)"); t.close();
  const bad = await mount({ prefs: { readFont: "comic-sans", uiFont: "x", confirmRead: "sometimes" } }); assert.equal(bad.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-newsreader)"); assert.equal(bad.win.document.documentElement.style.getPropertyValue("--ui"), "var(--ui-plex)"); bad.close();
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

test("Ubuntu, New York and SF Pro are offered, picked from cards and remembered", async () => {
  const t = await mount(); t.$$(".tab").find(b => b.textContent.includes("Settings")).click(); await wait(60); t.$$(".stab").find(b => b.textContent.includes("Look")).click(); await wait(40);
  const names = (n) => t.$$(".fontcard").map(c => c.querySelector(".fname").textContent.replace("In use", "")); const all = names();
  for (const f of ["Ubuntu", "SF Pro"]) assert.equal(all.filter(x => x === f).length, 2, f + " is in both pickers"); assert.equal(all.filter(x => x === "New York").length, 1, "New York is a serif, so only a reading font");
  assert.equal(t.$$(".fonthead").length, 3, "the reading picker has Serif and Sans headings, the interface picker only Sans"); assert.ok(t.$$(".fontcard .fnote").every(n => n.textContent.length > 10), "every card says in words what the font is for");
  const pick = async (label, nth) => { t.$$(".fontcard").filter(c => c.querySelector(".fname").textContent.replace("In use", "") === label)[nth].click(); await wait(30); };
  await pick("Ubuntu", 0); assert.equal(t.win.document.documentElement.style.getPropertyValue("--read-font"), "var(--serif-ubuntu)");
  await pick("Ubuntu", 1); assert.equal(t.win.document.documentElement.style.getPropertyValue("--ui"), "var(--ui-ubuntu)");
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
