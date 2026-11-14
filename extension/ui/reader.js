// Pravaha reader. Text is inserted as text nodes; article HTML goes through renderSafe, never innerHTML.
import { h, icon, pct, ago, longAgo } from "./dom.js";
import { gradeColor, disp } from "../src/grade.js";
import { renderSafe } from "../src/safehtml.js";
import { anchorTree } from "../src/anchor.js";
import { loadPrefs, savePrefs, applyPrefs, clamp } from "./prefs.js";

const $app = document.getElementById("app");
const send = async (m) => { try { return await browser.runtime.sendMessage(m); } catch (e) { toast("The background page did not answer. Reload the extension if this keeps happening."); throw e; } };
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const S = {
  tab: lsGet("pravaha.tab", "feed"), scope: "all", mode: "unread", ranked: false, q: "",
  settings: null, tree: [], status: null, rules: [], data: null, icons: {}, iconCount: 0, unread: 0,
  rows: new Map(), openCard: null, selId: null, keep: new Set(), content: {}, tags: {}, limits: {},
  collapsed: new Set(lsGet("pravaha.collapsed", [])), auto: new Set(), treeCollapsed: new Set(lsGet("pravaha.treeCollapsed", [])),
  newIds: new Set(), pop: null, help: false, toast: "", busy: false, stats: null,
  stab: "connections", draft: null, tests: {}, dirty: false
};
let U = loadPrefs();
const prefersDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
const setPref = (patch) => { U = { ...U, ...patch }; savePrefs(U); applyPrefs(U, document.documentElement, prefersDark()); if ("anchor" in patch || "anchorLevel" in patch) { refillOpenCard(); anchorSamples(); } };
function anchorSamples() { for (const el of $app.querySelectorAll("[data-sample]")) { el.textContent = el.dataset.sample; if (U.anchor) anchorTree(el, U.anchorLevel, document); } }
function refillOpenCard() { const r = S.openCard && S.rows.get(S.openCard); if (r && rowElById(r.id)) fillCard(r); }
export const disposeForTests = () => { clearTimeout(toastTimer); };

// ---------- small utilities ----------
let toastTimer = null;
function toast(t) {
  S.toast = t; let el = $app.querySelector(".toast");
  if (!el) { el = h("div", { class: "toast", role: "status" }); $app.append(el); }
  el.textContent = t; clearTimeout(toastTimer); toastTimer = setTimeout(() => { S.toast = ""; el.remove(); }, 3600);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const iconFor = (feedId, title) => {
  const src = S.icons[feedId];
  return h("span", { class: "fav", "aria-hidden": "true" }, src ? h("img", { src, alt: "", loading: "lazy" }) : (String(title || "?")[0] || "?").toUpperCase());
};
const gradeOf = (score) => { const d = disp(score); const c = gradeColor(d, U.palette); return { d, bg: c.bg, fg: c.fg }; };
const isFeedTab = () => S.tab === "feed" || S.tab === "saved";
const rowEls = () => Array.from($app.querySelectorAll(".group[data-collapsed='false'] .row:not([data-leaving='true'])"));
const rowElById = (id) => $app.querySelector(`.row[data-id="${id}"]`);
const groupOf = (id) => (S.data ? S.data.groups.find(g => g.rows.some(r => r.id === id)) : null);
const isCollapsed = (key) => S.collapsed.has(key) || S.auto.has(key);

// ---------- data ----------
async function loadView() {
  const r = await send({ type: "view", params: { scope: S.tab === "saved" ? "saved" : S.scope, mode: S.mode, ranked: S.ranked, q: S.q, keep: [...S.keep] } });
  S.data = r.view; S.tree = r.tree; S.status = r.status; S.unread = r.view.unreadTotal; S.newIds = new Set();
  S.rows = new Map(); for (const g of S.data.groups) for (const row of g.rows) S.rows.set(row.id, row);
  if (S.data.iconCount !== S.iconCount) { S.iconCount = S.data.iconCount; S.icons = (await send({ type: "icons" })) || {}; }
  if (S.openCard && !S.rows.has(S.openCard)) stopDwell(), S.openCard = null;
  render();
}
async function boot() {
  const b = await send({ type: "boot" });
  S.settings = b.settings; S.tree = b.tree; S.status = b.status; S.rules = b.rules || []; S.icons = b.icons || {}; S.iconCount = Object.keys(S.icons).length;
  U = loadPrefs(b.settings.theme); applyPrefs(U, document.documentElement, prefersDark());
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyPrefs(U, document.documentElement, prefersDark()));
  if (!b.settings.miniflux.token) S.tab = "settings";
  if (isFeedTab()) await loadView(); else render();
}
// Cheap refresh of counts and lights after local actions.
const refreshChrome = debounce(async () => {
  const r = await send({ type: "tree" }); S.tree = r.tree; S.status = r.status; S.unread = r.unreadTotal; renderChrome();
}, 350);
// Background updates: patch rows in place and offer new articles through a banner, never reshuffling under the reader.
const softReload = debounce(async () => {
  if (!isFeedTab() || !S.data) { refreshChrome(); if (S.tab === "sync") { S.status = await send({ type: "status" }); S.stats = await send({ type: "stats" }); renderMain(); } return; }
  const r = await send({ type: "view", params: { scope: S.tab === "saved" ? "saved" : S.scope, mode: S.mode, ranked: S.ranked, q: S.q, keep: [...S.keep] } });
  S.tree = r.tree; S.status = r.status; S.unread = r.view.unreadTotal; let fresh = 0;
  for (const g of r.view.groups) for (const n of g.rows) {
    const old = S.rows.get(n.id);
    if (!old) { if (!S.newIds.has(n.id)) fresh++; S.newIds.add(n.id); continue; }
    if (old.read !== n.read || old.saved !== n.saved || old.score !== n.score) { Object.assign(old, { read: n.read, saved: n.saved, score: n.score, why: n.why, breakdown: n.breakdown, flag: n.flag }); patchRow(old); }
  }
  if (r.view.iconCount !== S.iconCount) { S.iconCount = r.view.iconCount; S.icons = (await send({ type: "icons" })) || {}; }
  renderChrome(); showBanner();
}, 400);
browser.runtime.onMessage.addListener((m) => { if (m && m.type === "changed") softReload(); });

// ---------- actions ----------
function patchRow(r) {
  const el = rowElById(r.id); if (!el) return;
  el.dataset.read = String(r.read); el.dataset.saved = String(r.saved);
  const g = gradeOf(r.score); el.style.setProperty("--grade", g.bg); el.style.setProperty("--gfg", g.fg);
  const sc = el.querySelector(".score"); if (sc) sc.textContent = String(pct(g.d)); const bar = el.querySelector(".gbar i"); if (bar) bar.style.width = pct(g.d) + "%";
  const sv = el.querySelector("[data-act='save']"); if (sv) { sv.replaceChildren(icon("star", 17, r.saved)); sv.setAttribute("aria-pressed", String(r.saved)); sv.title = r.saved ? "Remove from saved (s)" : "Save (s)"; }
  const rd = el.querySelector("[data-act='read']"); if (rd) rd.textContent = r.read ? "Mark unread" : "Mark read";
  const cs = el.querySelector("[data-act='cardsave'] span"); if (cs) cs.textContent = r.saved ? "Saved" : "Save";
  const gr = groupOf(r.id); if (gr) updateGroupHead(gr);
}
function markRowsRead(ids, explicit = false) {
  const fresh = ids.filter(id => S.rows.get(id) && !S.rows.get(id).read);
  for (const id of fresh) { const r = S.rows.get(id); r.read = true; S.keep.add(id); patchRow(r); }
  if (ids.length) { send({ type: "markRead", ids, explicit }); refreshChrome(); }
}
async function markUnread(id) { const r = S.rows.get(id); if (!r) return; r.read = false; patchRow(r); send({ type: "markUnread", ids: [id] }); refreshChrome(); }
function toggleRead(r) { if (r.read) markUnread(r.id); else markRowsRead([r.id], true); }
async function saveRow(r) {
  r.saved = !r.saved; patchRow(r); const res = await send({ type: "save", id: r.id });
  if (res && res.saved) toast(res.tags && res.tags.length ? `Saved. Suggested tags: ${res.tags.join(", ")}.` : "Saved."); refreshChrome();
}
function dismissRow(r) {
  const el = rowElById(r.id); const g = groupOf(r.id);
  if (S.openCard === r.id) closeCard(r, true);
  if (el) { el.style.maxHeight = el.offsetHeight + "px"; requestAnimationFrame(() => { el.dataset.leaving = "true"; }); setTimeout(() => el.remove(), 260); }
  if (g) { g.rows = g.rows.filter(x => x.id !== r.id); updateGroupHead(g); }
  S.rows.delete(r.id); if (S.data) S.data.dismissedCount = (S.data.dismissedCount || 0) + 1; const oldSub = $app.querySelector(".sub"); if (oldSub) oldSub.replaceWith(feedSub());
  send({ type: "dismiss", id: r.id }); toast("Dismissed. The feed's standing drops a little. Undo dismissed is in the toolbar."); refreshChrome();
}
// Background open: a real tab, counted as an open (the strongest everyday signal).
async function backgroundOpen(r) {
  r.read = true; S.keep.add(r.id); patchRow(r); await send({ type: "open", id: r.id }); toast("Opened in a background tab and counted as interest."); refreshChrome();
}
async function fetchFull(r) {
  if (S.openCard !== r.id) await openCardFor(r);
  S.content[r.id] = { ...(S.content[r.id] || {}), loading: true }; fillCard(r);
  const res = await send({ type: "fetchFull", id: r.id });
  if (res && res.ok) { S.content[r.id] = { html: res.html, full: true }; toast("Full article loaded."); }
  else { S.content[r.id] = { ...(S.content[r.id] || {}), loading: false, notice: (res && res.sentence) || "The full article could not be fetched." }; }
  fillCard(r);
}
async function train(type, key, value) { await send({ type: "train", kind: type, key, value }); S.rules = await send({ type: "rules" }); if (S.openCard) fillCard(S.rows.get(S.openCard)); toast(value > 0 ? "Noted. You will see more like this." : value < 0 ? "Noted. You will see less like this." : "Training rule removed."); }
async function syncNow() { S.busy = true; renderChrome(); try { S.status = await send({ type: "syncNow" }); } finally { S.busy = false; } if (isFeedTab()) await loadView(); else { S.stats = await send({ type: "stats" }); render(); } }

// ---------- article card and dwell ----------
const dw = { id: null, feedId: null, start: 0 };
function startDwell(r) { stopDwell(); if (document.visibilityState === "visible" && document.hasFocus()) { dw.id = r.id; dw.feedId = r.feedId; dw.start = Date.now(); } else { dw.id = r.id; dw.feedId = r.feedId; dw.start = 0; } }
function stopDwell() { if (dw.id !== null && dw.start) { const ms = Date.now() - dw.start; if (ms >= 1000) send({ type: "dwell", id: dw.id, feedId: dw.feedId, ms }); } dw.start = 0; }
function resumeDwell() { if (dw.id !== null && !dw.start && document.visibilityState === "visible" && document.hasFocus()) dw.start = Date.now(); }
document.addEventListener("visibilitychange", () => (document.visibilityState === "hidden" ? stopDwell() : resumeDwell()));
window.addEventListener("blur", stopDwell); window.addEventListener("focus", resumeDwell); window.addEventListener("pagehide", () => { stopDwell(); dw.id = null; });

async function openCardFor(r) {
  if (S.openCard === r.id) return closeCard(r);
  if (S.openCard && S.rows.get(S.openCard)) closeCard(S.rows.get(S.openCard), true);
  S.openCard = r.id; selectRow(r.id);
  if (!r.read) { r.read = true; S.keep.add(r.id); patchRow(r); }
  send({ type: "card", id: r.id }); refreshChrome(); startDwell(r);
  const el = rowElById(r.id); if (!el) return;
  el.dataset.card = "false"; fillCard(r); requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.card = "true"; setTimeout(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60); }));
  const have = S.content[r.id];
  if (!have || (!have.html && !have.error && !have.loading)) {
    S.content[r.id] = { loading: true }; fillCard(r);
    const res = await send({ type: "content", id: r.id });
    S.content[r.id] = res && res.html != null ? { html: res.html, full: !!res.full } : { error: (res && res.error) || "The article text could not be loaded." };
    if (S.openCard === r.id) fillCard(r);
  }
}
function closeCard(r, quick = false) {
  stopDwell(); dw.id = null; if (S.openCard === r.id) S.openCard = null;
  const el = rowElById(r.id); if (!el) return; el.dataset.card = "false";
  const clear = () => { if (el.dataset.card === "false") el.querySelector(".cardin")?.replaceChildren(); }; quick ? clear() : setTimeout(clear, 340);
}
function fillCard(r) {
  const el = rowElById(r.id); if (!el) return; const host = el.querySelector(".cardin"); if (!host) return;
  const c = S.content[r.id] || {}; const bk = r.breakdown; const g = groupOf(r.id);
  const body = c.loading && !c.html ? h("div", { class: "skeleton", "aria-busy": "true" }, [90, 100, 96, 70, 100, 88].map(w => h("i", { style: { width: w + "%" } })))
    : c.html != null && c.html.trim() ? h("div", { class: "prose", lang: "en" }, renderSafe(c.html, document))
    : h("div", { class: "prose" }, h("p", {}, r.summary || "Miniflux has no text for this article."));
  if (U.anchor && body.classList.contains("prose")) anchorTree(body, U.anchorLevel, document);
  const need = c.html != null && !c.full && r.words && r.words < 150;
  const stems = [...new Set((r.title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(t => t.length > 4).slice(0, 4);
  const rule = (type, key) => (S.rules.find(x => x.type === type && x.key === String(key).toLowerCase()) || {}).value || 0;
  const tr = (name, type, key) => h("span", { class: "trainrow" }, h("span", {}, name), ...[["More", 1], ["Less", -1]].map(([l, v]) => h("button", { class: "kw", "data-v": String(Math.sign(rule(type, key)) === v ? v : 0), onclick: () => train(type, key, rule(type, key) === v ? 0 : v) }, l)));
  const bars = [["Tag match", bk.tagOverlap], ["Sites you read", bk.bookmarkEcho], ["Feed standing", bk.feedAuthority], ["Freshness", bk.freshness]].map(([n, v]) => h("div", { style: { "--grade": gradeOf(v).bg } }, h("span", {}, `${n}: ${pct(v)}`), h("div", { class: "gbar" }, h("i", { style: { width: pct(v) + "%" } }))));
  const tags = S.tags[r.id] || [];
  const btn = (act, ic, label, key, fn, on) => h("button", { class: "btn small" + (on ? " on" : ""), "data-act": act, onclick: fn }, icon(ic, 15, act === "cardsave" && r.saved), h("span", {}, label), key ? h("kbd", {}, key) : null);
  host.replaceChildren(h("div", { class: "card" },
    h("h2", { class: "ctitle" }, r.title),
    h("div", { class: "cmeta" }, h("span", { class: "fav-wrap", style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, iconFor(r.feedId, r.feedTitle), r.feedTitle), r.author ? h("span", {}, r.author) : null, h("span", {}, longAgo(r.publishedAt)),
      r.readingTime ? h("span", {}, `${r.readingTime} min read`) : null, c.full ? h("span", { class: "chip ok" }, icon("coffee", 12), "Full article") : null),
    h("div", { class: "cacts" },
      btn("bg", "ext", "Open in background", "b", () => backgroundOpen(r)),
      btn("full", "coffee", c.full ? "Reload full article" : "Fetch full article", "w", () => fetchFull(r), c.loading),
      btn("cardsave", "star", r.saved ? "Saved" : "Save", "s", () => saveRow(r), r.saved),
      h("button", { class: "btn small", "data-act": "read", onclick: () => toggleRead(r) }, r.read ? "Mark unread" : "Mark read"),
      btn("dismiss", "x", "Dismiss", "x", () => dismissRow(r)), btn("close", "up2", "Close", "Esc", () => closeCard(r))),
    c.notice ? h("div", { class: "notice" }, c.notice) : null, c.error ? h("div", { class: "notice" }, c.error + " Showing the summary instead.") : null,
    need ? h("div", { class: "notice" }, "This feed only sends a short excerpt. Press w, or the coffee button, to fetch the whole article.") : null,
    body,
    h("details", { class: "why", onclick: (e) => { if (e.target.tagName === "SUMMARY" && !S.tags[r.id]) { S.tags[r.id] = []; send({ type: "suggestTags", id: r.id }).then(t => { S.tags[r.id] = t || []; fillCard(r); const d = el.querySelector(".why"); if (d) d.open = true; }); } } },
      h("summary", {}, "Why it ranks here and train the ranking"), h("p", { class: "note" }, `Ranks here because it is ${r.why}.`), h("div", { class: "bars" }, bars),
      tags.length ? h("div", { class: "trainrow" }, h("span", {}, "Suggested tags:"), tags.map(t => h("span", { class: "kw" }, t.tag))) : null,
      h("div", { class: "trainrow" }, h("strong", {}, "Train:"), tr(r.feedTitle, "feed", r.feedId), r.author ? tr(r.author, "author", r.author) : null), h("div", { class: "trainrow" }, stems.map(s => tr(s, "keyword", s))))));
  if (g) updateGroupHead(g);
}

// ---------- feed view ----------
function selectRow(id) { S.selId = id; for (const e of $app.querySelectorAll(".row[data-sel='true']")) e.dataset.sel = "false"; const el = rowElById(id); if (el) el.dataset.sel = "true"; }
function rowEl(r) {
  const g = gradeOf(r.score); const ranked = S.ranked; const small = h("span", { class: "sep" }, "·");
  const meta = [ranked ? h("span", { class: "src" }, iconFor(r.feedId, r.feedTitle), " ", r.feedTitle) : null, r.author ? h("span", {}, r.author) : null, r.domain ? h("span", {}, r.domain) : null, h("span", { title: new Date(r.publishedAt).toLocaleString() }, ago(r.publishedAt)), r.readingTime ? h("span", {}, `${r.readingTime} min`) : null].filter(Boolean);
  const metaLine = []; meta.forEach((m, i) => { if (i) metaLine.push(h("span", { class: "sep" }, "·")); metaLine.push(m); });
  const chips = [r.newish && !r.read ? h("span", { class: "chip ok" }, "New") : null, r.media ? h("span", { class: "chip" }, icon(r.media === "audio" ? "music" : "play", 12), r.media === "audio" ? "Audio" : "Video") : null,
    r.comments ? h("a", { class: "chip", href: r.comments, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, icon("msg", 12), "Comments") : null,
    r.flag ? h("span", { class: "chip warn" }, "Serendipity") : null, r.words && r.words < 150 && !r.media ? h("span", { class: "chip", title: "This feed sends only an excerpt. Press w to fetch the full article." }, icon("coffee", 12), "Excerpt") : null,
    ...(r.tags || []).slice(0, 3).map(t => h("span", { class: "chip tag" }, "#" + t))].filter(Boolean);
  const act = (name, ic, title, fn, cls = "") => h("button", { class: "ibtn " + cls, "data-act": name, title, "aria-label": title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 17, name === "save" && r.saved));
  return h("article", { class: "row", data: { id: r.id, read: String(r.read), saved: String(r.saved), sel: String(S.selId === r.id), card: "false" }, style: { "--grade": g.bg, "--gfg": g.fg }, onclick: () => selectRow(r.id) },
    h("span", { class: "strip", "aria-hidden": "true" }),
    h("div", { class: "rmain" },
      h("div", { class: "rmeta" }, h("span", { class: "newdot", title: "Unread" }), metaLine),
      h("button", { class: "rtitle", onclick: (e) => { e.stopPropagation(); openCardFor(r); } }, r.title),
      r.summary ? h("div", { class: "rsnip" }, r.summary) : null, chips.length ? h("div", { class: "chips" }, chips) : null),
    h("div", { class: "rside" }, U.thumbs && r.thumb ? h("img", { class: "thumb", src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      h("div", { class: "grade", title: `Relevance ${pct(g.d)} of 100 (raw ${pct(r.score)}; ${r.why})` }, h("span", { class: "score" }, String(pct(g.d))), h("div", { class: "gbar" }, h("i", { style: { width: pct(g.d) + "%" } })))),
    h("div", { class: "acts" }, act("save", "star", r.saved ? "Remove from saved (s)" : "Save (s)", () => saveRow(r), "save"), act("bg", "ext", "Open in a background tab (b)", () => backgroundOpen(r)),
      act("full", "coffee", "Fetch the full article (w)", () => fetchFull(r)), act("dismiss", "x", "Dismiss (x)", () => dismissRow(r)), act("card", "down", "Read here (o)", () => openCardFor(r))),
    h("div", { class: "cardwrap" }, h("div", { class: "cardin" })));
}
function groupHead(g) {
  const unread = g.rows.filter(r => !r.read); const top = unread.slice().sort((a, b) => b.score - a.score).slice(0, 14);
  const done = unread.length === 0;
  const first = g.rows[0];
  return h("header", { class: "ghead" },
    h("button", { class: "gtoggle", "aria-expanded": String(!isCollapsed(g.key)), onclick: () => toggleGroup(g) },
      h("span", { class: "chev" }, icon("chev", 16)), g.feedId ? iconFor(g.feedId, g.title) : icon("bolt", 16), h("span", { class: "gtitle" }, g.title),
      h("span", { class: "gunread" + (done ? " zero" : "") }, done ? "all read" : `${unread.length} unread`), done ? h("span", { class: "gdone", title: "Read through" }, icon("check", 16)) : null,
      h("span", { class: "ticks", "aria-hidden": "true", title: "Relevance of the unread articles" }, top.map(r => { const gg = gradeOf(r.score); return h("i", { style: { "--c": gg.bg, "--h": Math.max(4, Math.round(4 + gg.d * 10)) + "px" } }); }))),
    h("button", { class: "btn small ghost", disabled: unread.length ? null : true, onclick: () => markSectionRead(g) }, icon("check", 15), "Mark section read"));
}
function updateGroupHead(g) { if (!g.el) return; const old = g.el.querySelector(".ghead"); if (old) old.replaceWith(groupHead(g)); }
function toggleGroup(g) {
  const was = isCollapsed(g.key); S.auto.delete(g.key);
  if (was) S.collapsed.delete(g.key); else S.collapsed.add(g.key);
  lsSet("pravaha.collapsed", [...S.collapsed]);
  if (g.el) { g.el.dataset.collapsed = String(!was); g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", String(was)); }
  if (!was && S.openCard && g.rows.some(r => r.id === S.openCard)) closeCard(S.rows.get(S.openCard), true);
}
function setAllGroups(collapse) {
  for (const g of S.data.groups) { S.auto.delete(g.key); collapse ? S.collapsed.add(g.key) : S.collapsed.delete(g.key); if (g.el) { g.el.dataset.collapsed = String(collapse); g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", String(!collapse)); } }
  lsSet("pravaha.collapsed", [...S.collapsed]); if (collapse && S.openCard) closeCard(S.rows.get(S.openCard), true);
}
// Marking a whole section read is the "read through" signal, so the section folds away.
function markSectionRead(g) {
  markRowsRead(g.rows.filter(r => !r.read).map(r => r.id));
  setTimeout(() => { S.auto.add(g.key); if (g.el) { g.el.dataset.collapsed = "true"; g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", "false"); } if (S.openCard && g.rows.some(r => r.id === S.openCard)) closeCard(S.rows.get(S.openCard), true); }, 380);
}
function markAllRead() {
  const ids = []; for (const g of S.data.groups) for (const r of g.rows) if (!r.read) ids.push(r.id);
  markRowsRead(ids); setTimeout(() => { for (const g of S.data.groups) { S.auto.add(g.key); if (g.el) { g.el.dataset.collapsed = "true"; g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", "false"); } } }, 380);
}
function fillGroupRows(g, inner) {
  const limit = S.limits[g.key] || 120; inner.replaceChildren(...g.rows.slice(0, limit).map(rowEl));
  if (g.rows.length > limit) inner.append(h("button", { class: "more", onclick: () => { S.limits[g.key] = limit + 200; fillGroupRows(g, inner); observeRows(); } }, `Show ${Math.min(200, g.rows.length - limit)} more of ${g.rows.length - limit} remaining`));
}
function groupEl(g) {
  const inner = h("div", { class: "gin" }); fillGroupRows(g, inner);
  g.el = h("section", { class: "group", data: { key: g.key, collapsed: String(isCollapsed(g.key)) } }, groupHead(g), h("div", { class: "gwrap" }, inner)); return g.el;
}
function showBanner() {
  const old = $app.querySelector(".banner"); if (old) old.remove(); if (!S.newIds.size || !isFeedTab()) return;
  const sub = $app.querySelector(".sub"); if (!sub) return;
  sub.after(h("button", { class: "banner", onclick: () => { S.keep = new Set(); loadView(); } }, icon("sync", 15), `${S.newIds.size} new article${S.newIds.size === 1 ? "" : "s"}. Click to show`));
}
function feedSub() {
  const d = S.data; const title = S.tab === "saved" ? "Saved" : S.scope === "all" ? "Newsfeed" : (S.tree.find(n => n.id === S.scope) || {}).label || "Newsfeed";
  const allCollapsed = d && d.groups.length && d.groups.every(g => isCollapsed(g.key));
  const sub = h("div", { class: "sub" }, h("h1", {}, title), h("span", { class: "meta" }, d ? `${d.unreadTotal} unread in total · ${d.total} shown` : ""),
    h("div", { class: "seg", role: "group", "aria-label": "Show" }, h("button", { "aria-pressed": String(S.mode === "unread"), onclick: () => { S.mode = "unread"; S.keep = new Set(); loadView(); } }, "Unread"), h("button", { "aria-pressed": String(S.mode === "all"), onclick: () => { S.mode = "all"; loadView(); } }, "All")),
    h("button", { class: "btn" + (S.ranked ? " on" : ""), title: "Sort every feed together by relevance", "aria-pressed": String(S.ranked), onclick: () => { S.ranked = !S.ranked; loadView(); } }, icon("bolt", 15), "Ranked"),
    h("div", { class: "seg", role: "group", "aria-label": "Density" }, h("button", { title: "Compact list", "aria-pressed": String(U.density === "compact"), onclick: () => { setPref({ density: "compact" }); render(); } }, icon("list", 15)), h("button", { title: "Comfortable list with excerpts and thumbnails", "aria-pressed": String(U.density !== "compact"), onclick: () => { setPref({ density: "comfortable" }); render(); } }, icon("grid", 15))),
    h("button", { class: "btn" + (U.scrollRead ? " on" : ""), title: "Mark articles read as they scroll past the top of the screen", "aria-pressed": String(U.scrollRead), onclick: () => { setPref({ scrollRead: !U.scrollRead }); toast(U.scrollRead ? "Articles are marked read once they scroll past the top." : "Scroll marking is off."); renderMain(); } }, icon("scroll", 15), "Read on scroll"),
    h("button", { class: "btn", title: allCollapsed ? "Expand every feed (Shift+C)" : "Collapse every feed (Shift+C)", onclick: () => { setAllGroups(!allCollapsed); renderMain(); } }, icon(allCollapsed ? "down2" : "up2", 15), allCollapsed ? "Expand all" : "Collapse all"),
    h("button", { class: "btn", disabled: d && d.groups.some(g => g.rows.some(r => !r.read)) ? null : true, onclick: markAllRead }, icon("check", 15), "Mark all read"),
    d && d.dismissedCount ? h("button", { class: "btn ghost", onclick: async () => { await send({ type: "undismissAll" }); loadView(); } }, icon("undo", 15), `Undo dismissed (${d.dismissedCount})`) : null);
  return sub;
}
function feedMain() {
  const d = S.data;
  const sub = feedSub();
  const body = d && d.groups.length ? h("div", { class: "feeds density-" + (U.density === "compact" ? "compact" : "comfortable") }, d.groups.map(groupEl))
    : h("div", { class: "empty" }, h("div", { class: "t" }, S.tab === "saved" ? "Nothing saved yet" : S.settings.miniflux.token ? "You are all caught up" : "Connect Miniflux to begin"),
      h("div", {}, S.tab === "saved" ? "Press s on an article and it will appear here." : S.settings.miniflux.token ? "No unread articles match this view. Try the All toggle." : "Open Settings and add your server address and API key."));
  return [sub, body];
}

// ---------- scroll marking ----------
let io = null; const seen = new Set(); const passed = new Set();
const flushPassed = debounce(() => { const ids = [...passed].filter(id => S.rows.get(id) && !S.rows.get(id).read && S.openCard !== id); passed.clear(); if (ids.length) markRowsRead(ids); }, 700);
function observeRows() {
  if (io) io.disconnect(); io = null; if (!U.scrollRead || !isFeedTab() || typeof IntersectionObserver === "undefined") return;
  const top = Math.round(($app.querySelector(".sub")?.getBoundingClientRect().bottom) || 100);
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const id = Number(en.target.dataset.id); const grp = en.target.closest(".group");
      if (grp && grp.dataset.collapsed === "true") continue;
      if (en.isIntersecting) { seen.add(id); passed.delete(id); }
      else if (seen.has(id) && en.boundingClientRect.height > 0 && en.boundingClientRect.bottom <= top + 1) { passed.add(id); flushPassed(); }
    }
  }, { rootMargin: `-${top}px 0px 0px 0px`, threshold: 0 });
  for (const el of $app.querySelectorAll(".row[data-read='false']")) io.observe(el);
}

// ---------- chrome: header, sidebar, popovers ----------
const TABS = [["feed", "Newsfeed", "list"], ["saved", "Saved", "star"], ["stats", "Stats", "chart"], ["sync", "Sync", "sync"], ["settings", "Settings", "gear"]];
const THEMES = ["light", "dark", "oled", "auto"]; const THEME_NAMES = { light: "Light", dark: "Dark", oled: "OLED black", auto: "Follow the system" };
function go(tab) {
  stopDwell(); dw.id = null; S.openCard = null; S.tab = tab; lsSet("pravaha.tab", tab); S.keep = new Set(); S.pop = null;
  if (tab === "feed" || tab === "saved") loadView();
  else if (tab === "stats") Promise.all([send({ type: "stats" }), send({ type: "rules" })]).then(([st, ru]) => { S.stats = st; S.rules = ru; render(); });
  else if (tab === "sync") Promise.all([send({ type: "status" }), send({ type: "stats" })]).then(([st, sa]) => { S.status = st; S.stats = sa; render(); });
  else { S.draft = null; render(); }
}
function topBar() {
  const st = S.status; const overall = st ? st.overall : "off";
  const text = overall === "green" ? "In sync" : overall === "red" ? "Needs attention" : overall === "amber" ? "Catching up" : "Not set up";
  const themeIcon = { light: icon("sun"), dark: icon("moon"), oled: icon("moon", 18, true), auto: icon("clock") }[U.theme];
  return h("header", { class: "top" },
    h("button", { class: "ibtn", title: "Show or hide the folder list", "aria-label": "Toggle folders", onclick: () => { setPref({ side: !U.side }); renderChrome(); } }, icon("menu", 20)),
    h("div", { class: "brand" }, h("img", { src: "../icons/icon-32.png", alt: "" }), "Pravaha"),
    h("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" }, TABS.map(([id, label, ic]) => h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === id), onclick: () => go(id) }, icon(ic, 16), h("span", { class: "lbl" }, label), id === "feed" && S.unread ? h("span", { class: "count" }, S.unread > 999 ? "999+" : S.unread) : null))),
    h("div", { class: "grow" }),
    isFeedTab() ? h("label", { class: "search" }, icon("search", 15), h("input", { type: "search", placeholder: "Search  ( / )", "aria-label": "Search articles", value: S.q, oninput: debounce((e) => { S.q = e.target.value; loadView(); }, 300) })) : null,
    h("button", { class: "ibtn aa", title: "Reading type", "aria-label": "Reading type", "aria-expanded": String(S.pop === "aa"), onclick: (e) => { e.stopPropagation(); S.pop = S.pop === "aa" ? null : "aa"; renderPop(); } }, "Aa"),
    h("button", { class: "ibtn", title: `Theme: ${THEME_NAMES[U.theme]}. Click to change.`, "aria-label": "Change theme", onclick: () => { setPref({ theme: THEMES[(THEMES.indexOf(U.theme) + 1) % THEMES.length] }); renderChrome(); toast("Theme: " + THEME_NAMES[U.theme]); } }, themeIcon),
    h("button", { class: "ibtn", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: () => { S.help = true; renderOverlay(); } }, icon("help")),
    h("button", { class: "pill", title: st ? "Open the Sync page" : "", onclick: () => go("sync") }, h("span", { class: "lamp " + overall + (overall === "green" ? " pulse" : "") }), text));
}
function sideBar() {
  const byId = new Map(S.tree.map(n => [n.id, n]));
  const hidden = (n) => { for (let p = n.parent && byId.get(n.parent); p; p = p.parent && byId.get(p.parent)) if (S.treeCollapsed.has(p.id)) return true; return false; };
  const hasKids = (n) => S.tree.some(x => x.parent === n.id);
  const rows = S.tree.filter(n => !hidden(n)).map(n => {
    const chev = n.type === "folder" && hasKids(n) ? h("button", { class: "chev", "aria-label": (S.treeCollapsed.has(n.id) ? "Expand " : "Collapse ") + n.label, "aria-expanded": String(!S.treeCollapsed.has(n.id)), onclick: () => { S.treeCollapsed.has(n.id) ? S.treeCollapsed.delete(n.id) : S.treeCollapsed.add(n.id); lsSet("pravaha.treeCollapsed", [...S.treeCollapsed]); renderChrome(); } }, icon("chev", 14)) : h("span", { class: "chev" });
    const cur = S.tab === "feed" && S.scope === n.id;
    return h("div", { class: "trow", style: { paddingLeft: n.depth * 14 + "px" } }, chev, h("button", { class: "tbtn", "aria-current": cur ? "true" : null, onclick: () => { S.scope = n.id; if (S.tab !== "feed") { S.tab = "feed"; lsSet("pravaha.tab", "feed"); } S.keep = new Set(); loadView(); } },
      n.type === "feed" ? iconFor(Number(n.id.slice(5)), n.label) : null, h("span", { class: "lbl" }, n.label), n.state && n.state !== "green" ? h("span", { class: "dot " + n.state, title: "This feed has trouble in Miniflux" }) : null, n.unread ? h("span", { class: "n" }, n.unread) : null));
  });
  return h("aside", { class: "side", "aria-label": "Folders and feeds" },
    h("div", { class: "trow" }, h("span", { class: "chev" }), h("button", { class: "tbtn", "aria-current": S.tab === "feed" && S.scope === "all" ? "true" : null, onclick: () => { S.scope = "all"; S.tab = "feed"; lsSet("pravaha.tab", "feed"); S.keep = new Set(); loadView(); } }, icon("list", 16), h("span", { class: "lbl" }, "All articles"), S.unread ? h("span", { class: "n" }, S.unread) : null)),
    rows);
}
function renderChrome() {
  const body = $app.querySelector(".body"); if (!body) return render();
  $app.querySelector(".top")?.replaceWith(topBar()); const side = body.querySelector(".side"); if (side) side.replaceWith(sideBar());
  body.dataset.side = U.side ? "on" : "off";
}
function range(label, key, lo, hi, step, fmt = (v) => v) {
  const out = h("span", {}, fmt(U[key]));
  return h("label", { class: "range" }, h("span", {}, label), h("input", { type: "range", min: lo, max: hi, step, value: U[key], oninput: (e) => { setPref({ [key]: Number(e.target.value) }); out.textContent = fmt(U[key]); } }), out);
}
function renderPop() {
  $app.querySelector(".pop")?.remove(); if (S.pop !== "aa") return;
  $app.append(h("div", { class: "pop", role: "dialog", "aria-label": "Reading type", onclick: (e) => e.stopPropagation() },
    h("div", { class: "seg" }, [["newsreader", "Newsreader"], ["literata", "Literata"]].map(([id, l]) => h("button", { "aria-pressed": String(U.readFont === id), style: { fontFamily: `var(--serif-${id})`, flex: 1, justifyContent: "center" }, onclick: () => { setPref({ readFont: id }); renderPop(); } }, l))),
    range("Size", "readSize", 15, 26, 1, (v) => v + "px"), range("Line gap", "readLine", 1.3, 2, 0.05, (v) => Number(v).toFixed(2)), range("Width", "readWidth", 46, 90, 2, (v) => v + "ch"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: U.anchor, onchange: (e) => { setPref({ anchor: e.target.checked }); renderPop(); } }), "Anchor bolding"),
    range("Strength", "anchorLevel", 1, 5, 1, (v) => ["", "Lightest", "Light", "Medium", "Strong", "Strongest"][v]),
    h("p", { class: "prose", "data-sample": "The quick brown fox reads the morning news, one calm paragraph at a time.", style: { margin: 0, fontSize: "calc(var(--read-size) * .9)" } }, "The quick brown fox reads the morning news, one calm paragraph at a time.")));
  anchorSamples();
}
document.addEventListener("click", (e) => { if (S.pop && !e.target.closest(".pop") && !e.target.closest(".aa")) { S.pop = null; renderPop(); renderChrome(); } });
const SHORTCUTS = [["j / k", "Next or previous article (opens it if a card is open)"], ["o or Enter", "Read here as a card"], ["b", "Open in a background tab, counted as interest"], ["w", "Fetch the full article (the coffee button)"], ["s", "Save or unsave"], ["x", "Dismiss"], ["m", "Mark read or unread"], ["Shift+A", "Mark the section read and fold it"], ["c", "Fold or unfold the section"], ["Shift+C", "Fold or unfold every section"], ["u", "Switch between Unread and All"], ["r", "Sync now"], ["/", "Search"], ["Esc", "Close the card or this panel"], ["?", "Show this list"]];
function renderOverlay() {
  $app.querySelector(".overlay")?.remove(); if (!S.help) return;
  $app.append(h("div", { class: "overlay", onclick: () => { S.help = false; renderOverlay(); } }, h("div", { class: "dialog", role: "dialog", "aria-label": "Keyboard shortcuts", onclick: (e) => e.stopPropagation() }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, d]) => h("div", {}, h("span", {}, d), h("kbd", {}, k)))), h("p", { class: "note", style: { marginTop: "12px" } }, "Shortcuts pause while you type in a box."))));
}

// ---------- main area ----------
function render() {
  const view = isFeedTab() ? feedMain() : S.tab === "stats" ? statsMain() : S.tab === "sync" ? syncMain() : settingsMain();
  const body = h("div", { class: "body", "data-side": U.side ? "on" : "off" }, sideBar(), h("main", { class: "main" }, view));
  $app.replaceChildren(topBar(), body); renderPop(); renderOverlay(); afterMain();
}
function renderMain() { const m = $app.querySelector(".main"); if (!m) return render(); m.replaceChildren(...(isFeedTab() ? feedMain() : S.tab === "stats" ? statsMain() : S.tab === "sync" ? syncMain() : settingsMain())); afterMain(); }
function afterMain() {
  const sub = $app.querySelector(".sub"); const topH = 52 + (sub ? sub.getBoundingClientRect().height : 0);
  document.documentElement.style.setProperty("--ghead-top", Math.round(topH) + "px");
  if (S.openCard && S.rows.has(S.openCard)) { const r = S.rows.get(S.openCard); const el = rowElById(r.id); if (el) { el.dataset.card = "true"; fillCard(r); } }
  showBanner(); observeRows(); anchorSamples();
}

// ---------- stats ----------
const hbar = (name, value, max, color, label) => h("div", { class: "hbar" }, h("span", { class: "name", title: name }, name), h("span", { class: "track" }, h("i", { style: { width: (max ? value / max * 100 : 0) + "%", background: color } })), h("span", { class: "val" }, label != null ? label : String(value)));
function statsMain() {
  const s = S.stats; if (!s) return [h("div", { class: "empty" }, "Loading")];
  const tiles = [["Read in the reader", s.cards], ["Opened in tabs", s.opens], ["Saved", s.saves], ["Dismissed", s.dismisses], ["Minutes reading", s.dwellMinutes]].map(([n, v]) => h("div", { class: "stat" }, h("b", {}, String(v)), h("span", {}, n + ", last 30 days")));
  const maxB = Math.max(1, ...s.bands.map(b => b.n)); const maxO = Math.max(1, ...s.bands.map(b => b.opened));
  const col = (b) => gradeOf((b.lo + b.hi) / 2).bg;
  const rules = S.rules.length ? S.rules.map(r => h("div", { class: "trainrow" }, h("span", { class: "kw", "data-v": String(Math.sign(r.value)) }, `${r.type}: ${r.key}`), h("span", {}, r.value > 0 ? "more" : "less"), h("button", { class: "kw", onclick: async () => { await train(r.type, r.key, 0); go("stats"); } }, "Remove"))) : [h("p", { class: "note" }, "No training rules yet. Open an article and use More or Less under its ranking panel.")];
  const folders = s.savesByFolder.length ? s.savesByFolder.map(([n, v]) => hbar(n, v, Math.max(1, ...s.savesByFolder.map(x => x[1])), "var(--accent)")) : [h("p", { class: "note" }, "Nothing saved in the last 30 days.")];
  return [h("div", { class: "page" }, h("h1", {}, "Reading stats"), h("div", { class: "tiles" }, tiles),
    h("div", { class: "cols" },
      h("div", { class: "panel" }, h("h2", {}, "Articles by relevance"), s.bands.map(b => hbar(`${pct(disp(b.lo))} to ${pct(disp(b.hi))}`, b.n, maxB, col(b), String(b.n))), h("p", { class: "note" }, "Darker means more relevant.")),
      h("div", { class: "panel" }, h("h2", {}, "Share opened, by relevance"), s.bands.map(b => hbar(`${pct(disp(b.lo))} to ${pct(disp(b.hi))}`, b.opened, maxO, col(b), b.n ? Math.round(b.opened / b.n * 100) + "%" : "0%")), h("p", { class: "note" }, "If the darker bands are opened more often, the ranking is working for you.")),
      h("div", { class: "panel" }, h("h2", {}, "Feed standing"), s.league.map(f => hbar(f.title, f.authority, 1, gradeOf(f.authority).bg, String(pct(f.authority)))), h("p", { class: "note" }, "Rises when you read and save a feed, falls when you skip or dismiss it.")),
      h("div", { class: "panel" }, h("h2", {}, "Saves by folder"), folders), h("div", { class: "panel" }, h("h2", {}, "Your training rules"), rules)))];
}

// ---------- sync ----------
function syncMain() {
  const st = S.status; if (!st) return [h("div", { class: "empty" }, "Loading")]; const l = st.left || {}; const machines = Array.isArray(l.machines) ? l.machines : [];
  const lights = st.lights.map(x => h("div", { class: "light" }, h("span", { class: "lamp " + x.state }), h("div", {}, h("b", {}, `${x.label}: ${x.state === "green" ? "good" : x.state === "amber" ? "catching up" : x.state === "red" ? "needs attention" : "off"}`), h("span", {}, x.sentence))));
  const hist = (S.stats && S.stats.pendingHistory) || []; const max = Math.max(1, ...hist.map(p => p.pending));
  const spark = hist.length > 1 ? (() => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 300 60"); svg.setAttribute("width", "100%"); svg.setAttribute("height", "60"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Changes waiting to sync over time");
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline"); pl.setAttribute("points", hist.map((p, i) => `${(i / (hist.length - 1) * 300).toFixed(1)},${(56 - p.pending / max * 52).toFixed(1)}`).join(" ")); pl.setAttribute("fill", "none"); pl.setAttribute("stroke", "var(--accent)"); pl.setAttribute("stroke-width", "2"); svg.appendChild(pl); return svg; })() : h("p", { class: "note" }, "The history chart fills in after a few syncs.");
  const n = (l.events || 0) + (l.ops || 0);
  return [h("div", { class: "page" }, h("h1", {}, "Sync"),
    h("div", { class: "hero" }, h("div", { style: { flex: "1 1 260px" } }, h("h2", {}, st.overall === "green" ? "All in sync" : st.overall === "red" ? "Something needs attention" : st.overall === "amber" ? "Catching up" : "Not set up yet"),
      h("p", {}, `${n ? `${n} change${n === 1 ? "" : "s"} still to sync` : "Nothing left to sync"}${machines.length ? `. Other machines: ${machines.map(m => m.device || "machine").join(", ")}.` : "."}`)),
      h("button", { class: "btn primary", onclick: syncNow }, icon("sync", 15), S.busy ? "Syncing" : "Sync now"), h("button", { class: "btn", onclick: async () => { const r = await send({ type: "digest" }); toast(r.sentence); } }, "Write digest now")),
    h("div", { class: "panel" }, lights), h("div", { class: "panel" }, h("h2", {}, "Changes waiting over time"), spark))];
}

// ---------- settings ----------
const DEFAULT_ORIGINS = ["https://reader.miniflux.app", "https://myfiles.fastmail.com"];
const customOrigin = (url) => { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; return DEFAULT_ORIGINS.includes(u.origin) ? null : u.origin + "/*"; } catch { return null; } };
const complete = (w, d) => w === "miniflux" ? d.miniflux.url && d.miniflux.token : w === "webdav" ? d.webdav.url && d.webdav.user && d.webdav.pass : d.raindrop.token;
const SVC = { miniflux: "Miniflux", webdav: "WebDAV storage", raindrop: "Raindrop" };
function ensureDraft() { if (!S.draft) { S.draft = JSON.parse(JSON.stringify(S.settings)); S.dirty = false; } return S.draft; }
function setTest(which, state, sentence) { S.tests[which] = { state, sentence }; const el = $app.querySelector(`[data-test="${which}"]`); if (el) { el.className = "res " + state; el.replaceChildren(h("span", { class: "lamp " + (state === "ok" ? "green" : state === "bad" ? "red" : "off"), style: { marginTop: "4px" } }), h("span", {}, sentence)); } }
// gesture=true when called from a click, so Firefox can show its permission prompt for a custom server.
async function runTest(which, gesture = false) {
  const d = ensureDraft(); if (!complete(which, d)) { setTest(which, "idle", "Fill in every box above, then it is tested automatically."); return false; }
  const need = customOrigin(which === "raindrop" ? "" : d[which].url);
  if (need) {
    if (gesture) { const ok = await browser.permissions.request({ origins: [need] }); if (!ok) { setTest(which, "bad", "Firefox was not allowed to reach that server. Press Test again and choose Allow."); return false; } }
    else if (!(await browser.permissions.contains({ origins: [need] }))) { setTest(which, "idle", "Press Test so Firefox can ask permission to reach this server."); return false; }
  }
  setTest(which, "wait", "Testing now"); const r = await send({ type: "test", which, creds: { miniflux: d.miniflux, webdav: d.webdav, raindrop: d.raindrop } });
  setTest(which, r.ok ? "ok" : "bad", r.sentence); return !!r.ok;
}
const autoTest = {}; const queueTest = (w) => { clearTimeout(autoTest[w]); autoTest[w] = setTimeout(() => runTest(w, false), 700); };
function markDirty() { S.dirty = true; const b = $app.querySelector(".savebar [data-save]"); if (b) b.disabled = false; const t = $app.querySelector(".savebar .note"); if (t) t.textContent = "You have unsaved changes."; }
async function saveDraft() {
  const d = ensureDraft(); const origins = [...new Set(["miniflux", "webdav"].map(w => customOrigin(d[w].url)).filter(Boolean))];
  const granted = origins.length ? await browser.permissions.request({ origins }) : true;
  const patch = { miniflux: d.miniflux, webdav: d.webdav, raindrop: d.raindrop, weights: d.weights, novelty: d.novelty, pollMinutes: Number(d.pollMinutes) || 2, retentionDays: Number(d.retentionDays) || 30, autoTag: d.autoTag, saveToRaindrop: d.saveToRaindrop, autoDigest: d.autoDigest, syncCreds: d.syncCreds, device: (d.device || "this-machine").trim() };
  S.settings = await send({ type: "saveSettings", patch }); S.draft = null; ensureDraft(); S.dirty = false;
  const b = $app.querySelector(".savebar [data-save]"); if (b) b.disabled = true; const t = $app.querySelector(".savebar .note"); if (t) t.textContent = granted ? "Saved. Testing each connection now." : "Saved, but Firefox did not allow your custom server.";
  const results = await Promise.all(["miniflux", "webdav", "raindrop"].filter(w => complete(w, S.draft)).map(w => runTest(w, false)));
  if (t && S.draft.miniflux.token) t.textContent = results.every(Boolean) ? "Saved. Every connection answered." : "Saved. See the lights above for any connection that needs a fix.";
  if (results[0]) { const go1 = $app.querySelector("[data-gofeed]"); if (go1) go1.hidden = false; }
}
function settingsMain() {
  const d = ensureDraft(); const tab = S.stab;
  const inp = (label, obj, key, type = "text", w = null, ph = "") => h("label", { class: "field" }, label, h("input", { type, value: obj[key] ?? "", placeholder: ph, autocomplete: "off", spellcheck: "false", oninput: (e) => { obj[key] = type === "number" ? Number(e.target.value) : e.target.value; markDirty(); if (w) queueTest(w); } }));
  const chk = (label, obj, key, after) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; if (after) after(e.target.checked); else markDirty(); } }), label);
  const conn = (w, fields, help) => h("div", { class: "conn" }, h("h3", {}, SVC[w]), ...fields, h("div", { class: "res " + ((S.tests[w] || {}).state || "idle"), "data-test": w }, (S.tests[w] || {}).sentence ? [h("span", { class: "lamp " + (S.tests[w].state === "ok" ? "green" : S.tests[w].state === "bad" ? "red" : "off"), style: { marginTop: "4px" } }), h("span", {}, S.tests[w].sentence)] : h("span", { class: "note" }, help)),
    h("div", {}, h("button", { class: "btn small", onclick: () => runTest(w, true) }, "Test now")));
  let content;
  if (tab === "connections") content = [h("div", { class: "conns" },
    conn("miniflux", [inp("Server address", d.miniflux, "url", "text", "miniflux"), inp("API key", d.miniflux, "token", "password", "miniflux")], "Miniflux, Settings, API Keys. Tested as soon as both boxes are filled."),
    conn("webdav", [inp("Server address", d.webdav, "url", "text", "webdav"), inp("User name", d.webdav, "user", "text", "webdav"), inp("App password", d.webdav, "pass", "password", "webdav"), inp("Folder", d.webdav, "root", "text", "webdav")], "Fastmail app password with Files access. The test writes a small file."),
    conn("raindrop", [inp("API token", d.raindrop, "token", "password", "raindrop")], "Optional. Gives tag suggestions and one-way saving.")),
    chk("Carry these keys between my machines with Firefox Sync", d, "syncCreds"), chk("Save starred articles to Raindrop", d, "saveToRaindrop"), chk("Suggest tags from my Raindrop tags", d, "autoTag")];
  else if (tab === "look") content = [h("div", { class: "panel" }, h("h2", {}, "Look"),
    h("div", { class: "grid2" }, h("div", { class: "field" }, "Theme", h("div", { class: "seg" }, THEMES.map(t => h("button", { "aria-pressed": String(U.theme === t), onclick: (e) => { setPref({ theme: t }); renderMain(); renderChrome(); } }, THEME_NAMES[t].split(" ")[0])))),
      h("div", { class: "field" }, "Relevance colours", h("div", { class: "seg" }, ["ember", "saffron", "moss"].map(p => h("button", { "aria-pressed": String(U.palette === p), onclick: () => { setPref({ palette: p }); renderMain(); } }, p[0].toUpperCase() + p.slice(1))))),
      h("div", { class: "field" }, "Density", h("div", { class: "seg" }, [["compact", "Compact"], ["comfortable", "Comfortable"]].map(([id, l]) => h("button", { "aria-pressed": String((U.density === "compact") === (id === "compact")), onclick: () => { setPref({ density: id }); renderMain(); } }, l))))),
    chk("Show thumbnails (these load from the publisher's site)", U, "thumbs", (v) => { setPref({ thumbs: v }); }), chk("Mark articles read as they scroll past the top", U, "scrollRead", (v) => { setPref({ scrollRead: v }); })),
    h("div", { class: "panel" }, h("h2", {}, "Reading type"), h("div", { class: "seg", style: { width: "max-content" } }, [["newsreader", "Newsreader"], ["literata", "Literata"]].map(([id, l]) => h("button", { "aria-pressed": String(U.readFont === id), style: { fontFamily: `var(--serif-${id})` }, onclick: () => { setPref({ readFont: id }); renderMain(); } }, l))),
      range("Size", "readSize", 15, 26, 1, (v) => v + "px"), range("Line gap", "readLine", 1.3, 2, 0.05, (v) => Number(v).toFixed(2)), range("Width", "readWidth", 46, 90, 2, (v) => v + "ch"),
      chk("Anchor bolding: bold the start of each word (English and other Latin text)", U, "anchor", (v) => { setPref({ anchor: v }); renderMain(); }), range("Anchor strength", "anchorLevel", 1, 5, 1, (v) => ["", "Lightest", "Light", "Medium", "Strong", "Strongest"][v]),
      h("div", { class: "sample prose" }, h("p", { "data-sample": "Reading is a daily discipline. A comfortable measure, a generous line gap and a calm serif let a long article carry you along without effort." }, "Reading is a daily discipline. A comfortable measure, a generous line gap and a calm serif let a long article carry you along without effort."), h("p", { "data-sample": "Changes apply instantly and stay on this machine." }, "Changes apply instantly and stay on this machine.")))];
  else if (tab === "ranking") content = [h("div", { class: "panel" }, h("h2", {}, "Relevance weights"), ...[["tag", "Tag match"], ["echo", "Sites you read"], ["authority", "Feed standing"], ["freshness", "Freshness"]].map(([k, l]) => { const out = h("span", {}, pct(d.weights[k])); return h("label", { class: "range" }, h("span", {}, l), h("input", { type: "range", min: 0, max: 1, step: 0.05, value: d.weights[k], oninput: (e) => { d.weights[k] = Number(e.target.value); out.textContent = pct(d.weights[k]); markDirty(); } }), out); }),
    h("p", { class: "note" }, "Only the proportions matter. They are rescaled to add up to one when saved."), chk("Boost feeds I have not opened this session", d, "novelty"))];
  else if (tab === "machine") content = [h("div", { class: "panel" }, h("h2", {}, "This machine"), h("div", { class: "grid2" }, inp("Machine name (set once, keep it)", d, "device"), inp("Check for new articles every (minutes)", d, "pollMinutes", "number"), inp("Keep read articles for (days)", d, "retentionDays", "number")), chk("Write the weekly digest automatically", d, "autoDigest"))];
  else content = [h("div", { class: "panel" }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, v]) => h("div", {}, h("span", {}, v), h("kbd", {}, k)))))];
  const needSave = tab === "connections" || tab === "ranking" || tab === "machine";
  return [h("div", { class: "page" }, h("h1", {}, "Settings"),
    S.settings && !S.settings.miniflux.token ? h("div", { class: "hero" }, h("div", {}, h("h2", {}, "Start here"), h("p", {}, "Paste your Miniflux address and API key. Each connection is tested the moment its boxes are filled, and again when you save."))) : null,
    h("div", { class: "stabs", role: "tablist" }, [["connections", "Connections"], ["look", "Look and reading"], ["ranking", "Ranking"], ["machine", "This machine"], ["keys", "Shortcuts"]].map(([id, l]) => h("button", { class: "stab", role: "tab", "aria-selected": String(S.stab === id), onclick: () => { S.stab = id; renderMain(); } }, l))),
    ...content,
    needSave ? h("div", { class: "savebar" }, h("button", { class: "btn primary", "data-save": "1", disabled: S.dirty ? null : true, onclick: saveDraft }, "Save and test"), h("button", { class: "btn", "data-gofeed": "1", hidden: !(S.settings && S.settings.miniflux.token), onclick: () => go("feed") }, "Open Newsfeed"), h("span", { class: "note" }, S.dirty ? "You have unsaved changes." : "Nothing to save.")) : null)];
}

// ---------- keyboard ----------
function selectOffset(d, openIt) {
  const els = rowEls(); if (!els.length) return; let i = els.findIndex(e => Number(e.dataset.id) === S.selId); i = i < 0 ? (d > 0 ? 0 : els.length - 1) : Math.min(els.length - 1, Math.max(0, i + d));
  const id = Number(els[i].dataset.id); selectRow(id); els[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (openIt && S.rows.get(id)) openCardFor(S.rows.get(id));
}
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; const t = e.target; const typing = t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
  if (e.key === "Escape") { if (S.help) { S.help = false; renderOverlay(); } else if (S.pop) { S.pop = null; renderPop(); } else if (typing) t.blur(); else if (S.openCard && S.rows.get(S.openCard)) closeCard(S.rows.get(S.openCard)); return; }
  if (typing) return;
  if (e.key === "?") { S.help = !S.help; renderOverlay(); e.preventDefault(); return; }
  if (!isFeedTab() || !S.data) return;
  if (e.key === "/") { $app.querySelector(".search input")?.focus(); e.preventDefault(); return; }
  const r = S.rows.get(S.selId); const cardOpen = !!S.openCard;
  const handled = (() => {
    switch (e.key) {
      case "j": selectOffset(1, cardOpen); return true; case "k": selectOffset(-1, cardOpen); return true;
      case "o": case "Enter": if (r) openCardFor(r); return true; case "b": if (r) backgroundOpen(r); return true; case "w": if (r) fetchFull(r); return true;
      case "s": if (r) saveRow(r); return true; case "m": if (r) toggleRead(r); return true;
      case "x": if (r) { const els = rowEls(); const i = els.findIndex(el => Number(el.dataset.id) === r.id); const next = els[i + 1] || els[i - 1]; dismissRow(r); if (next) selectRow(Number(next.dataset.id)); } return true;
      case "c": { const g = r && groupOf(r.id); if (g) toggleGroup(g); return true; }
      case "C": setAllGroups(!S.data.groups.every(g => isCollapsed(g.key))); renderMain(); return true;
      case "A": { const g = r && groupOf(r.id); if (g) markSectionRead(g); return true; }
      case "u": S.mode = S.mode === "unread" ? "all" : "unread"; S.keep = new Set(); loadView(); return true;
      case "r": syncNow(); return true; default: return false;
    }
  })();
  if (handled) e.preventDefault();
});

boot().catch(err => { $app.replaceChildren(h("div", { class: "empty" }, h("div", { class: "t" }, "Pravaha could not start"), h("div", {}, String(err && err.message || err)), h("pre", { class: "errstack" }, String(err && err.stack || "").split("\n").slice(0, 6).join("\n")))); });
