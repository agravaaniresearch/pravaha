// Pravaha reader. All DOM is built with createElement and textContent, never innerHTML.
import { tokenize } from "../src/text.js";

const $app = document.getElementById("app");
const send = (m) => browser.runtime.sendMessage(m);

import { gradeColor, disp } from "../src/grade.js";

const S = {
  view: "feed", scope: "all", mode: "unread", ranked: false, q: "", settings: null, tree: [], status: null, rules: [], data: null,
  expanded: new Set(), keep: new Set(), sel: -1, flat: [], collapsed: new Set(), stats: null, toast: "", tags: {}, busy: false
};
try { const c = JSON.parse(localStorage.getItem("pravaha.collapsed") || "[]"); S.collapsed = new Set(c); } catch { /* ignore */ }
const saveCollapsed = () => { try { localStorage.setItem("pravaha.collapsed", JSON.stringify([...S.collapsed])); } catch { /* ignore */ } };

// ---------- DOM helpers ----------
const NS = "http://www.w3.org/2000/svg";
const ICONS = {
  chev: "M9 6l6 6-6 6", star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z", x: "M6 6l12 12M18 6L6 18",
  down: "M6 9l6 6 6-6", search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5", ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  list: "M4 6h16M4 12h16M4 18h10", bolt: "M13 3L5 14h6l-1 7 8-11h-6z", chart: "M4 20V10M10 20V4M16 20v-8M22 20H2", sync: "M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2 1-1.5 3-2.2-.5-1.5 1.5.5 2.2-3 1.5-1-2h-3l-1 2-3-1.5.5-2.2L5.7 15.5 3.5 16 2 13l2-1V11l-2-1 1.5-3 2.2.5L7.2 6 6.7 3.8 9.7 2.3l1 2h3l1-2 3 1.5-.5 2.2L18.8 7.5 21 7l1.5 3-2 1z"
};
function icon(name, size = 20) {
  const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", name === "star" ? "currentColor" : "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "1.8"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", ICONS[name]); s.appendChild(p); return s;
}
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v; else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (k === "data") for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
    else if (v === true) e.setAttribute(k, ""); else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
const when = (ms) => { const m = Math.max(0, (Date.now() - ms) / 60000); return m < 60 ? Math.max(1, Math.round(m)) + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };
const pct = (x) => Math.round(x * 100);
function toast(t) { S.toast = t; render(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = ""; render(); }, 3500); }

// ---------- data ----------
async function loadView() {
  const r = await send({ type: "view", params: { scope: S.view === "saved" ? "saved" : S.scope, mode: S.mode, ranked: S.ranked, q: S.q, keep: [...S.keep] } });
  S.data = r.view; S.tree = r.tree; S.status = r.status; render();
}
async function boot() {
  const b = await send({ type: "boot" }); S.settings = b.settings; S.tree = b.tree; S.status = b.status; S.rules = b.rules || [];
  applyTheme(); await loadView();
  if (!S.settings.miniflux.token) S.view = "settings", render();
}
function applyTheme() { document.documentElement.dataset.theme = S.settings.theme || "light"; }
let reloadTimer = null;
browser.runtime.onMessage.addListener((m) => {
  if (m && m.type === "changed") { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (S.view === "feed" || S.view === "saved") loadView(); else if (S.view === "sync") refreshStatus(); }, 250); }
});
async function refreshStatus() { S.status = await send({ type: "status" }); if (S.view === "sync") S.stats = await send({ type: "stats" }); render(); }

// ---------- actions ----------
const findRow = (id) => { for (const g of S.data.groups) for (const r of g.rows) if (r.id === id) return r; return null; };
async function markRead(ids, explicit = false) { ids.forEach(id => { const r = findRow(id); if (r) { r.read = true; S.keep.add(id); } }); render(); await send({ type: "markRead", ids, explicit }); }
async function markUnread(ids) { ids.forEach(id => { const r = findRow(id); if (r) r.read = false; }); render(); await send({ type: "markUnread", ids }); }
async function openRow(r) { r.read = true; S.keep.add(r.id); render(); await send({ type: "open", id: r.id }); }
async function saveRow(r) { r.saved = !r.saved; render(); const res = await send({ type: "save", id: r.id }); if (res && res.saved && res.tags && res.tags.length) toast("Saved. Tags suggested: " + res.tags.join(", ") + "."); else if (res && res.saved) toast("Saved."); }
async function dismissRow(r) { for (const g of S.data.groups) g.rows = g.rows.filter(x => x.id !== r.id); render(); await send({ type: "dismiss", id: r.id }); toast("Dismissed. This lowers the feed's standing a little."); }
async function toggleDetails(r) { if (S.expanded.has(r.id)) S.expanded.delete(r.id); else { S.expanded.add(r.id); if (!S.tags[r.id]) { S.tags[r.id] = []; send({ type: "suggestTags", id: r.id }).then(t => { S.tags[r.id] = t || []; render(); }); } } render(); }
async function train(type, key, value) { await send({ type: "train", kind: type, key, value }); S.rules = await send({ type: "rules" }); await loadView(); toast(value > 0 ? "Noted. You will see more like this." : value < 0 ? "Noted. You will see less like this." : "Training rule removed."); }
async function syncNow() { S.busy = true; render(); try { S.status = await send({ type: "syncNow" }); S.stats = await send({ type: "stats" }); await loadView(); } finally { S.busy = false; render(); } }
const visibleRows = () => (S.data ? S.data.groups.flatMap(g => g.rows) : []);

// ---------- sidebar ----------
function sidebar() {
  const st = S.status; const overall = st ? st.overall : "off";
  const nav = (id, label, ic, badge) => h("button", { class: "navbtn", "aria-current": S.view === id && (id !== "feed" || S.scope === "all") ? "page" : null, onclick: () => { S.view = id; if (id === "feed") S.scope = "all"; go(); } }, icon(ic), h("span", { class: "grow" }, label), badge ? h("span", { class: "badge" }, badge) : null);
  const byId = new Map(S.tree.map(n => [n.id, n]));
  const hidden = (n) => { for (let p = n.parent && byId.get(n.parent); p; p = p.parent && byId.get(p.parent)) if (S.collapsed.has(p.id)) return true; return false; };
  const hasKids = (n) => S.tree.some(x => x.parent === n.id);
  const rows = S.tree.filter(n => !hidden(n)).map(n => {
    const current = S.view === "feed" && S.scope === n.id;
    const chev = n.type === "folder" && hasKids(n)
      ? h("button", { class: "chev", "aria-label": (S.collapsed.has(n.id) ? "Expand " : "Collapse ") + n.label, "aria-expanded": String(!S.collapsed.has(n.id)), onclick: () => { S.collapsed.has(n.id) ? S.collapsed.delete(n.id) : S.collapsed.add(n.id); saveCollapsed(); render(); } }, icon("chev", 16))
      : h("span", { class: "chev" });
    const lead = n.type === "feed" ? h("span", { class: "tile" }, (n.label[0] || "?").toUpperCase()) : null;
    return h("div", { class: "trow", style: { paddingLeft: n.depth * 14 + "px" } }, chev,
      h("button", { class: "tbtn", "aria-current": current ? "true" : null, onclick: () => { S.view = "feed"; S.scope = n.id; go(); } },
        lead, h("span", { class: "lbl" }, n.label), n.state && n.state !== "green" ? h("span", { class: "dot " + n.state, title: "This feed has trouble" }) : null, n.unread ? h("span", { class: "cnt" }, n.unread) : null));
  });
  const unread = S.data ? S.data.unreadTotal : 0;
  return h("aside", { class: "side" },
    h("div", { class: "brand" }, h("img", { src: "../icons/icon-32.png", width: 28, height: 28, alt: "" }), "Pravaha"),
    h("nav", { class: "nav", "aria-label": "Main" }, nav("feed", "Newsfeed", "list", unread || null), nav("saved", "Saved", "star"), nav("stats", "Reading stats", "chart"), nav("sync", "Sync", "sync"), nav("settings", "Settings", "gear")),
    h("div", { class: "rule" }),
    h("div", { class: "tree", role: "tree", "aria-label": "Folders and feeds" }, rows),
    h("button", { class: "pill", onclick: () => { S.view = "sync"; go(); } },
      h("b", {}, h("span", { class: "dot " + (overall === "off" ? "off" : overall) }), overall === "green" ? "All in sync" : overall === "red" ? "Sync needs attention" : overall === "amber" ? "Catching up" : "Not set up"),
      h("span", {}, st ? syncSummary(st) : "")));
}
function syncSummary(st) { const l = st.left || {}; const n = (l.events || 0) + (l.ops || 0); return n ? `${n} change${n === 1 ? "" : "s"} still to sync.` : "Nothing left to sync."; }
async function go() {
  S.keep = new Set(); S.sel = -1;
  if (S.view === "feed" || S.view === "saved") await loadView();
  else if (S.view === "stats") { S.stats = await send({ type: "stats" }); S.rules = await send({ type: "rules" }); render(); }
  else if (S.view === "sync") { S.status = await send({ type: "status" }); S.stats = await send({ type: "stats" }); render(); }
  else render();
}

// ---------- feed view ----------
const titleFor = () => {
  if (S.view === "saved") return "Saved";
  if (S.scope === "all") return "Newsfeed";
  const n = S.tree.find(x => x.id === S.scope); return n ? n.label : "Newsfeed";
};
function header() {
  const total = S.data ? S.data.unreadTotal : 0;
  return h("div", { class: "head" },
    h("div", {}, h("div", { class: "kicker" }, S.view === "saved" ? "Your keepers" : "Your reading"), h("h1", {}, titleFor()),
      h("div", { class: "sub" }, S.data ? `${total} unread across all feeds. ${S.data.total} shown here.` : "")),
    h("label", { class: "search" }, icon("search", 18), h("input", { type: "search", placeholder: "Search titles and summaries", "aria-label": "Search", value: S.q, onchange: (e) => { S.q = e.target.value; loadView(); } })));
}
function toolbar() {
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Show" },
    h("button", { "aria-pressed": String(S.mode === "unread"), onclick: () => { S.mode = "unread"; S.keep = new Set(); loadView(); } }, "Unread"),
    h("button", { "aria-pressed": String(S.mode === "all"), onclick: () => { S.mode = "all"; loadView(); } }, "All"));
  const ids = visibleRows().filter(r => !r.read).map(r => r.id);
  return h("div", { class: "toolbar" }, seg,
    h("button", { class: "btn toggle", "aria-pressed": String(S.ranked), onclick: () => { S.ranked = !S.ranked; loadView(); } }, icon("bolt", 18), "Ranked"),
    h("button", { class: "btn", disabled: ids.length ? null : true, onclick: () => markRead(ids) }, "Mark all as read"),
    S.data && S.data.dismissedCount ? h("button", { class: "btn ghost", onclick: async () => { await send({ type: "undismissAll" }); loadView(); } }, `Undo dismissed (${S.data.dismissedCount})`) : null,
    h("button", { class: "btn primary", disabled: S.busy ? true : null, onclick: syncNow }, icon("sync", 18), S.busy ? "Syncing" : "Sync now"));
}
function gradeBar(score) {
  const d = disp(score); const c = gradeColor(d, S.settings.palette);
  return h("div", { class: "grade", title: `Relevance ${pct(d)} out of 100 (raw score ${pct(score)}; bars are stretched so a raw 65 is a full bar)` }, h("div", { class: "gbar" }, h("i", { style: { width: pct(d) + "%", background: c.bg } })), h("span", { class: "chip", style: { background: c.bg, color: c.fg } }, String(pct(d))));
}
function detail(r, group, idx) {
  const b = r.breakdown; const tags = S.tags[r.id] || [];
  const bars = [["Tag match", b.tagOverlap], ["Sites you read", b.bookmarkEcho], ["Feed standing", b.feedAuthority], ["Freshness", b.freshness]].map(([n, v]) => {
    const c = gradeColor(v, S.settings.palette); return h("div", {}, h("span", {}, `${n}: ${pct(v)}`), h("div", { class: "gbar" }, h("i", { style: { width: pct(v) + "%", background: c.bg } })));
  });
  const stems = [...new Set(tokenize(r.title))].filter(t => t.length > 3).slice(0, 4);
  const rule = (type, key) => (S.rules.find(x => x.type === type && x.key === String(key).toLowerCase()) || {}).value || 0;
  const btn = (label, type, key, v) => h("button", { class: "kw", "data-v": String(Math.sign(rule(type, key))), onclick: () => train(type, key, rule(type, key) === v ? 0 : v) }, label);
  const trainRow = (name, type, key) => h("span", { class: "chips" }, h("span", {}, name), btn("More", type, key, 1), btn("Less", type, key, -1));
  return h("div", { class: "detail" },
    r.summary ? h("p", {}, r.summary) : null,
    h("div", { class: "rwhy" }, "Why it ranks here: " + r.why + "."),
    h("div", { class: "bars" }, bars),
    tags.length ? h("div", { class: "chips" }, h("span", {}, "Suggested tags:"), tags.map(t => h("span", { class: "kw" }, t.tag))) : null,
    h("div", { class: "chips" }, h("span", {}, "Train:"), trainRow(r.feedTitle, "feed", r.feedId), r.author ? trainRow(r.author, "author", r.author) : null, stems.map(s => trainRow(s, "keyword", s))),
    h("div", { class: "chips" },
      h("button", { class: "kw", onclick: () => markRead(group.rows.slice(0, idx).filter(x => !x.read).map(x => x.id)) }, "Mark everything above as read"),
      h("button", { class: "kw", onclick: () => (r.read ? markUnread([r.id]) : markRead([r.id], true)) }, r.read ? "Mark as unread" : "Mark as read")));
}
function rowEl(r, group, idx) {
  const flatIdx = S.flat.length; S.flat.push(r);
  const el = h("div", { class: "row", role: "article", data: { sel: String(S.sel === flatIdx), id: r.id } },
    h("span", { class: "unread", style: { background: r.read ? "transparent" : "var(--accent)" }, title: r.read ? "Read" : "Unread" }),
    h("button", { class: "ibtn" + (r.saved ? " on" : ""), "aria-label": r.saved ? "Remove from saved" : "Save", "aria-pressed": String(r.saved), onclick: () => saveRow(r) }, icon("star")),
    h("button", { class: "rtext", onclick: () => openRow(r), title: "Open in a background tab" },
      h("span", { class: "rtitle", style: { fontWeight: r.read ? 400 : 600, opacity: r.read ? .65 : 1 } }, r.title),
      r.summary ? h("span", { class: "rsnip" }, r.summary) : null,
      S.ranked ? h("span", { class: "rwhy" }, `${r.feedTitle}. ${r.why}.`) : null),
    r.flag ? h("span", { class: "flag" }, r.flag) : null,
    gradeBar(r.score), h("span", { class: "when" }, when(r.publishedAt)),
    h("button", { class: "ibtn", "aria-label": "Details and training", "aria-expanded": String(S.expanded.has(r.id)), onclick: () => toggleDetails(r) }, icon("down")),
    h("button", { class: "ibtn", "aria-label": "Dismiss", onclick: () => dismissRow(r) }, icon("x")),
    S.expanded.has(r.id) ? detail(r, group, idx) : null);
  return el;
}
function feedView() {
  S.flat = [];
  const groups = S.data ? S.data.groups : [];
  const body = groups.length ? groups.map(g => h("section", { class: "card" },
    h("div", { class: "ghead" }, h("span", { class: "tile2" }, (g.title[0] || "?").toUpperCase()), h("span", { class: "title grow" }, g.title), h("span", { class: "meta" }, `${g.unread} unread`),
      h("button", { class: "mark", disabled: g.unread ? null : true, onclick: () => markRead(g.rows.filter(x => !x.read).map(x => x.id)) }, "Mark section as read")),
    g.rows.map((r, i) => rowEl(r, g, i))))
    : [h("div", { class: "empty" }, h("div", { class: "t" }, S.view === "saved" ? "Nothing saved yet" : S.settings.miniflux.token ? "You are all caught up" : "Connect Miniflux to begin"),
      h("div", {}, S.view === "saved" ? "Star an article and it will appear here." : S.settings.miniflux.token ? "No unread articles match this view. Try the All toggle." : "Open Settings and add your server address and API key."))];
  return [header(), toolbar(), ...body];
}

// ---------- stats ----------
function hbar(name, value, max, color, label) { return h("div", { class: "hbar" }, h("span", { class: "name", title: name }, name), h("span", { class: "track" }, h("i", { style: { width: (max ? value / max * 100 : 0) + "%", background: color } })), h("span", { class: "val" }, label != null ? label : String(value))); }
function statsView() {
  const s = S.stats; if (!s) return [h("div", { class: "empty" }, "Loading")];
  const tiles = [["Opened", s.opens], ["Saved", s.saves], ["Dismissed", s.dismisses], ["Minutes reading", s.dwellMinutes]].map(([n, v]) => h("div", { class: "stat" }, h("b", {}, String(v)), h("span", {}, n + " in the last 30 days")));
  const maxBand = Math.max(1, ...s.bands.map(b => b.n));
  const bands = s.bands.map(b => hbar(`${pct(b.lo)} to ${pct(b.hi)}`, b.n, maxBand, gradeColor(disp((b.lo + b.hi) / 2), S.settings.palette).bg, `${b.n}`));
  const hit = s.bands.map(b => hbar(`${pct(b.lo)} to ${pct(b.hi)}`, b.opened, Math.max(1, ...s.bands.map(x => x.opened)), gradeColor(disp((b.lo + b.hi) / 2), S.settings.palette).bg, b.n ? `${Math.round(b.opened / b.n * 100)}%` : "0%"));
  const league = s.league.map(f => hbar(f.title, f.authority, 1, gradeColor(f.authority, S.settings.palette).bg, String(pct(f.authority))));
  const maxF = Math.max(1, ...s.savesByFolder.map(x => x[1]));
  const folders = s.savesByFolder.length ? s.savesByFolder.map(([n, v]) => hbar(n, v, maxF, "var(--accent)")) : [h("p", { class: "note" }, "Nothing saved yet in the last 30 days.")];
  const rules = S.rules.length ? S.rules.map(r => h("div", { class: "chips" }, h("span", { class: "kw", "data-v": String(Math.sign(r.value)) }, `${r.type}: ${r.key}`), h("span", {}, r.value > 0 ? "more" : "less"), h("button", { class: "kw", onclick: () => train(r.type, r.key, 0) }, "Remove"))) : [h("p", { class: "note" }, "No training rules yet. Open an article's details and choose More or Less.")];
  return [h("div", { class: "head" }, h("div", {}, h("div", { class: "kicker" }, "Last 30 days"), h("h1", {}, "Reading stats"))), h("div", { class: "tiles" }, tiles),
    h("div", { class: "cols" },
      h("div", { class: "panel" }, h("h2", {}, "Articles by relevance"), bands, h("p", { class: "note" }, "Darker means more relevant. The count is how many articles sit in each band right now.")),
      h("div", { class: "panel" }, h("h2", {}, "Share opened by band"), hit, h("p", { class: "note" }, "If the darker bands have higher shares, the ranking is working for you.")),
      h("div", { class: "panel" }, h("h2", {}, "Feed standing"), league, h("p", { class: "note" }, "Standing rises when you open and read a feed and falls when you skip or dismiss it.")),
      h("div", { class: "panel" }, h("h2", {}, "Saves by folder"), folders),
      h("div", { class: "panel" }, h("h2", {}, "Your training rules"), rules))];
}

// ---------- sync ----------
function syncView() {
  const st = S.status; if (!st) return [h("div", { class: "empty" }, "Loading")];
  const l = st.left || {}; const machines = Array.isArray(l.machines) ? l.machines : [];
  const lights = st.lights.map(x => h("div", { class: "light" }, h("span", { class: "lamp " + x.state, "aria-hidden": "true" }), h("div", {}, h("b", {}, `${x.label}: ${x.state === "green" ? "good" : x.state === "amber" ? "catching up" : x.state === "red" ? "needs attention" : "off"}`), h("span", {}, x.sentence))));
  const hist = (S.stats && S.stats.pendingHistory) || [];
  const max = Math.max(1, ...hist.map(p => p.pending));
  const spark = hist.length > 1 ? (() => {
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 300 60"); svg.setAttribute("width", "100%"); svg.setAttribute("height", "60"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Changes waiting to sync over time");
    const pts = hist.map((p, i) => `${(i / (hist.length - 1) * 300).toFixed(1)},${(56 - p.pending / max * 52).toFixed(1)}`).join(" ");
    const pl = document.createElementNS(NS, "polyline"); pl.setAttribute("points", pts); pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "#e08a00"); pl.setAttribute("stroke-width", "2"); svg.appendChild(pl); return svg;
  })() : h("p", { class: "note" }, "The history chart fills in after a few syncs.");
  const result = (k) => S["test_" + k] ? h("span", { class: "result " + (S["test_" + k].ok ? "ok" : "bad") }, S["test_" + k].sentence) : null;
  return [h("div", { class: "head" }, h("div", {}, h("div", { class: "kicker" }, "Sync"), h("h1", {}, "Everything in one place"), h("div", { class: "sub" }, syncSummary(st)))),
    h("div", { class: "hero" }, h("div", { style: { flex: "1 1 280px" } }, h("h2", {}, st.overall === "green" ? "All in sync" : st.overall === "red" ? "Something needs attention" : st.overall === "amber" ? "Catching up" : "Not set up yet"),
      h("p", {}, `${l.events || 0} reading event${l.events === 1 ? "" : "s"} and ${l.ops || 0} read or save change${l.ops === 1 ? "" : "s"} are waiting. ${machines.length ? "Other machines: " + machines.map(m => typeof m === "string" ? m : (m.device || m.name || "machine")).join(", ") + "." : ""}`)),
      h("div", { class: "toolbar" }, h("button", { class: "btn primary", onclick: syncNow }, icon("sync", 18), S.busy ? "Syncing" : "Sync now"), h("button", { class: "btn", onclick: async () => { const r = await send({ type: "digest" }); toast(r.sentence); } }, "Write digest now"))),
    h("div", { class: "panel" }, lights),
    h("div", { class: "panel" }, h("h2", {}, "Changes waiting over time"), spark),
    h("div", { class: "panel" }, h("h2", {}, "Test connections"), h("div", { class: "toolbar" },
      ["miniflux", "webdav", "raindrop"].map(k => h("span", { class: "chips" }, h("button", { class: "btn", onclick: async () => { S["test_" + k] = await send({ type: "test", which: k }); render(); } }, "Test " + (k === "webdav" ? "WebDAV" : k[0].toUpperCase() + k.slice(1))), result(k)))))];
}

// ---------- settings ----------
function settingsView() {
  const s = S.settings; const draft = JSON.parse(JSON.stringify(s));
  const inp = (label, path, type = "text", ph = "") => {
    const get = () => path.reduce((o, k) => o[k], draft); const last = path[path.length - 1]; const parent = path.slice(0, -1).reduce((o, k) => o[k], draft);
    return h("label", { class: "field" }, label, h("input", { type, value: get(), placeholder: ph, autocomplete: "off", spellcheck: "false", oninput: (e) => { parent[last] = type === "number" ? Number(e.target.value) : e.target.value; } }));
  };
  const chk = (label, key) => h("label", { class: "field check" }, h("input", { type: "checkbox", checked: draft[key] ? true : null, onchange: (e) => { draft[key] = e.target.checked; } }), label);
  const sel = (label, key, opts) => h("label", { class: "field" }, label, h("select", { onchange: (e) => { draft[key] = e.target.value; } }, opts.map(o => h("option", { value: o, selected: draft[key] === o ? true : null }, o))));
  const wl = [["tag", "Tag match"], ["echo", "Sites you read"], ["authority", "Feed standing"], ["freshness", "Freshness"]];
  const weights = wl.map(([k, n]) => h("label", { class: "field" }, `${n}: weight`, h("input", { type: "number", min: "0", max: "1", step: "0.05", value: draft.weights[k], oninput: (e) => { draft.weights[k] = Number(e.target.value); } })));
  const save = async () => {
    // Permissions must be requested from the click itself, before any await.
    const origins = []; for (const u of [draft.miniflux.url, draft.webdav.url]) { try { const o = new URL(u).origin; if (!/^https:\/\/(reader\.miniflux\.app|myfiles\.fastmail\.com)$/.test(o)) origins.push(o + "/*"); } catch { /* ignore */ } }
    let perm = Promise.resolve(true); if (origins.length) perm = browser.permissions.request({ origins }).catch(() => false);
    const granted = await perm;
    S.settings = await send({ type: "saveSettings", patch: draft }); applyTheme(); toast(granted ? "Settings saved. Syncing now." : "Settings saved, but the browser did not grant access to your custom server.");
  };
  return [h("div", { class: "head" }, h("div", {}, h("div", { class: "kicker" }, "Settings"), h("h1", {}, "Make it yours"))),
    h("div", { class: "panel" }, h("h2", {}, "Miniflux"), h("div", { class: "form" }, inp("Server address", ["miniflux", "url"]), inp("API key", ["miniflux", "token"], "password"))),
    h("div", { class: "panel" }, h("h2", {}, "WebDAV storage"), h("div", { class: "form" }, inp("Server address", ["webdav", "url"]), inp("User name", ["webdav", "user"]), inp("App password", ["webdav", "pass"], "password"), inp("Folder", ["webdav", "root"])),
      h("p", { class: "note" }, "Use an app password, not your main one. Both machines must use the same folder and different machine names. Pick the machine name once and keep it.")),
    h("div", { class: "panel" }, h("h2", {}, "Raindrop"), h("div", { class: "form" }, inp("API token", ["raindrop", "token"], "password")), chk("Save starred articles to Raindrop", "saveToRaindrop"), chk("Suggest tags from my existing Raindrop tags", "autoTag")),
    h("div", { class: "panel" }, h("h2", {}, "This machine"), h("div", { class: "form" }, inp("Machine name", ["device"]), inp("Check for new articles every (minutes)", ["pollMinutes"], "number"), inp("Keep read articles for (days)", ["retentionDays"], "number"), sel("Theme", "theme", ["light", "dark", "auto"]), sel("Relevance colours", "palette", ["ember", "saffron", "moss"])),
      chk("Boost feeds I have not opened this session", "novelty"), chk("Write the weekly digest automatically", "autoDigest"), chk("Carry my keys between machines with Firefox Sync", "syncCreds"),
      h("p", { class: "note" }, "Firefox Sync is off by default, so keys stay on this machine. If you turn it on, keys travel inside your encrypted Firefox account.")),
    h("div", { class: "panel" }, h("h2", {}, "Relevance weights"), h("div", { class: "form" }, weights), h("p", { class: "note" }, "The four weights are rescaled to add up to one, so only their proportions matter.")),
    h("div", {}, h("button", { class: "btn primary", onclick: save }, "Save settings"))];
}

// ---------- render ----------
function render() {
  const keepScroll = window.scrollY;
  const content = S.view === "feed" || S.view === "saved" ? feedView() : S.view === "stats" ? statsView() : S.view === "sync" ? syncView() : settingsView();
  $app.replaceChildren(h("div", { class: "shell" }, S.settings ? sidebar() : null, h("main", { class: "main" }, content)), S.toast ? h("div", { class: "toast", role: "status" }, S.toast) : null);
  window.scrollTo(0, keepScroll);
  const sel = $app.querySelector('.row[data-sel="true"]'); if (sel && S._scrollSel) { sel.scrollIntoView({ block: "nearest" }); S._scrollSel = false; }
}

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; const t = e.target && e.target.tagName; if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
  if (S.view !== "feed" && S.view !== "saved") return;
  const rows = S.flat; const r = rows[S.sel];
  const move = (d) => { S.sel = Math.min(rows.length - 1, Math.max(0, (S.sel < 0 ? (d > 0 ? -1 : 1) : S.sel) + d)); S._scrollSel = true; render(); };
  if (e.key === "j") move(1); else if (e.key === "k") move(-1);
  else if (r && e.key === "o") openRow(r); else if (r && e.key === "s") saveRow(r); else if (r && e.key === "x") dismissRow(r);
  else if (r && e.key === "m") (r.read ? markUnread([r.id]) : markRead([r.id], true)); else if (r && e.key === "Enter") toggleDetails(r);
  else if (e.key === "r") syncNow(); else return;
  e.preventDefault();
});

boot().catch(err => { $app.replaceChildren(h("div", { class: "empty" }, h("div", { class: "t" }, "Pravaha could not start"), h("div", {}, String(err && err.message || err)))); });
