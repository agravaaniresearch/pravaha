// Pravaha reader. Text is inserted as text nodes; article HTML goes through renderSafe, never innerHTML.
import { h, icon, pct, ago, longAgo } from "./dom.js";
import { gradeColor, disp } from "../src/grade.js";
import { renderSafe } from "../src/safehtml.js";
import { anchorTree } from "../src/anchor.js";
import { loadPrefs, normalisePrefs, savePrefs, applyPrefs, clamp, READ_FONTS, UI_FONTS, FONT_INFO, CONFIRM_MODES } from "./prefs.js";

const $app = document.getElementById("app");
const MUTATING = new Set(["markRead", "markUnread", "markScope", "save", "dismiss", "undismissAll", "syncNow", "subscribe", "searchServer", "card", "open"]);
const send = async (m) => {
  if (MUTATING.has(m.type)) setTimeout(kickSync, 60);
  try { return await browser.runtime.sendMessage(m); } catch (e) { toast("The background page did not answer. Reload the extension if this keeps happening.", { kind: "error" }); throw e; }
};
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const S = {
  tab: lsGet("pravaha.tab", "feed"), scope: "all", mode: "unread", ranked: false, q: "",
  settings: null, tree: [], status: null, rules: [], data: null, icons: {}, iconCount: 0, unread: 0,
  rows: new Map(), openCard: null, selId: null, keep: new Set(), content: {}, tags: {}, limits: {},
  collapsed: new Set(lsGet("pravaha.collapsed", [])), auto: new Set(), treeCollapsed: new Set(lsGet("pravaha.treeCollapsed", [])),
  newIds: new Set(), pop: null, help: false, toast: "", busy: false, stats: null, searchIn: "all", reorder: false, dialog: null, syncFlash: 0,
  stab: "connections", draft: null, tests: {}, dirty: false
};
let U = loadPrefs();
const prefersDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
let uiPushT = null;
const pushUi = () => { clearTimeout(uiPushT); uiPushT = setTimeout(() => { try { localStorage.setItem("pravaha.ui.at", String(Date.now())); } catch { /* ignore */ } send({ type: "saveUi", ui: U }).catch(() => {}); }, 500); };
// Look and fonts chosen on another machine arrive in settings.ui; take them when they are newer than what this reader last saved.
function adoptRemoteUi(settings) {
  const r = settings && settings.ui; if (!r || typeof r !== "object") return false;
  const next = normalisePrefs(r); if (JSON.stringify(next) === JSON.stringify(U)) return false;
  const at = Number(((settings.syncMeta || {}).ui || {}).at || 0); let local = 0; try { local = Number(localStorage.getItem("pravaha.ui.at") || 0); } catch { /* ignore */ }
  if (at <= local) return false;
  U = next; savePrefs(U); try { localStorage.setItem("pravaha.ui.at", String(at)); } catch { /* ignore */ }
  applyPrefs(U, document.documentElement, prefersDark()); return true;
}
const setPref = (patch) => { U = { ...U, ...patch }; savePrefs(U); pushUi(); applyPrefs(U, document.documentElement, prefersDark()); if ("anchor" in patch || "anchorLevel" in patch) { refillOpenCard(); anchorSamples(); } };
function anchorSamples() { for (const el of $app.querySelectorAll("[data-sample]")) { el.textContent = el.dataset.sample; if (U.anchor) anchorTree(el, U.anchorLevel, document); } }
function refillOpenCard() { const r = S.openCard && S.rows.get(S.openCard); if (r && rowElById(r.id)) fillCard(r); }
export const disposeForTests = () => { clearTimeout(pollT); for (const t of toastTimers) clearTimeout(t); };

// ---------- small utilities ----------
const toastTimers = new Set();
const TOAST_ICON = { success: "ok", info: "info", warn: "warn", error: "warn" };
// Toasts live outside the app container, so a redraw of the page never wipes one. Newest sits at the bottom.
function toast(text, o = {}) {
  const kind = o.kind || "info"; S.toast = text;
  let box = document.querySelector(".toasts"); if (!box) { box = h("div", { class: "toasts", "aria-live": "polite", role: "status" }); document.body.append(box); }
  for (const old of [...box.children]) if (old.dataset.text === text) old.remove();
  while (box.children.length >= 4) box.firstChild.remove();
  let timer = null; const el = h("div", { class: "toast", "data-kind": kind, "data-text": text });
  const close = () => { clearTimeout(timer); toastTimers.delete(timer); el.dataset.leaving = "true"; setTimeout(() => el.remove(), 220); };
  el.append(...[icon(TOAST_ICON[kind] || "info", 18), h("span", { class: "tmsg" }, text),
    o.action ? h("button", { class: "tact", onclick: () => { close(); o.action.fn(); } }, o.action.label) : null,
    h("button", { class: "tx", "aria-label": "Dismiss", onclick: close }, icon("x", 14))].filter(Boolean));
  box.append(el); timer = setTimeout(close, o.ms || (o.action ? 8000 : kind === "error" || kind === "warn" ? 6500 : 3800)); toastTimers.add(timer);
  return close;
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
const searchQuery = () => { const q = S.q.trim(); return /(^|\s)in:\w+/i.test(q) || S.searchIn === "all" ? q : `${q} in:${S.searchIn}`; };
async function loadSearch() {
  const [r, t] = await Promise.all([send({ type: "search", q: searchQuery() }), send({ type: "tree" })]);
  S.tree = t.tree; S.status = t.status; S.unread = t.unreadTotal;
  S.data = { search: true, terms: r.terms || [], indexSize: r.indexSize, empty: r.empty, groups: r.rows.length ? [{ key: "search", search: true, title: "Search results", unread: r.rows.filter(x => !x.read).length, rows: r.rows }] : [], total: r.rows.length, unreadTotal: S.unread, dismissedCount: 0, iconCount: S.iconCount };
  S.rows = new Map(); for (const row of r.rows) S.rows.set(row.id, row);
  if (S.openCard && !S.rows.has(S.openCard)) stopDwell(), S.openCard = null;
  render();
}
async function loadView() {
  if (S.q.trim()) return loadSearch();
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
  U = loadPrefs(b.settings.theme); const tookUi = adoptRemoteUi(b.settings); applyPrefs(U, document.documentElement, prefersDark());
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyPrefs(U, document.documentElement, prefersDark()));
  probeFonts();
  if (!b.settings.miniflux.token) S.tab = "settings";
  if (isFeedTab()) await loadView(); else render();
  handleHash(); kickSync(); loadFx();
  if (tookUi) toast("Look and fonts brought in from Firefox Sync.", { kind: "success" });
}
// Cheap refresh of counts and lights after local actions.
const refreshChrome = debounce(async () => {
  const r = await send({ type: "tree" }); S.tree = r.tree; S.status = r.status; S.unread = r.unreadTotal; renderChrome();
}, 350);
// Background updates: patch rows in place and offer new articles through a banner, never reshuffling under the reader.
const softReload = debounce(async () => {
  if (S.data && S.data.search && isFeedTab()) {
    refreshChrome(); const rs = await send({ type: "search", q: searchQuery() });
    for (const n of rs.rows) { const old = S.rows.get(n.id); if (old && (old.read !== n.read || old.saved !== n.saved)) { Object.assign(old, { read: n.read, saved: n.saved }); patchRow(old); } }
    return;
  }
  if (!isFeedTab() || !S.data) { refreshChrome(); if (S.tab === "sync") { S.status = await send({ type: "status" }); S.stats = await send({ type: "stats" }); renderMain(); } return; }
  const r = await send({ type: "view", params: { scope: S.tab === "saved" ? "saved" : S.scope, mode: S.mode, ranked: S.ranked, q: S.q, keep: [...S.keep] } });
  S.tree = r.tree; S.status = r.status; S.unread = r.view.unreadTotal; let fresh = 0;
  for (const g of r.view.groups) for (const n of g.rows) {
    const old = S.rows.get(n.id);
    if (!old) { if (!S.newIds.has(n.id)) fresh++; S.newIds.add(n.id); continue; }
    if (old.read !== n.read || old.saved !== n.saved || old.score !== n.score || old.pending !== n.pending) { Object.assign(old, { read: n.read, saved: n.saved, score: n.score, why: n.why, breakdown: n.breakdown, flag: n.flag, pending: n.pending }); patchRow(old); }
  }
  if (r.view.iconCount !== S.iconCount) { S.iconCount = r.view.iconCount; S.icons = (await send({ type: "icons" })) || {}; }
  renderChrome(); showBanner();
}, 400);
browser.runtime.onMessage.addListener((m) => { if (m && m.type === "changed") { softReload(); kickSync(); } else if (m && m.type === "profile") onProfile(m.applied || []); });
const PART_WORDS = { keys: "keys", settings: "settings", order: "folder order", ui: "look and fonts" };
const since = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
// Something arrived from another machine through Firefox Sync.
async function onProfile(applied) {
  try {
    const b = await send({ type: "boot" }); const hadKeys = !!(S.settings && S.settings.miniflux.token); S.settings = b.settings; S.tree = b.tree; S.status = b.status; S.draft = null; adoptRemoteUi(b.settings);
    const by = [...new Set(applied.map(a => a.by).filter(Boolean))].join(", ");
    toast(`Brought in ${applied.map(a => PART_WORDS[a.part] || a.part).join(", ")} from Firefox Sync${by ? ` (saved by ${by})` : ""}.`, { kind: "success", action: !hadKeys && S.settings.miniflux.token ? { label: "Open Newsfeed", fn: () => go("feed") } : null });
    if (S.tab === "settings") render(); else renderChrome();
    loadFx();
  } catch { /* the background page will tell the reader again on the next change */ }
}
async function loadFx() { try { S.fx = await send({ type: "profileSync" }); } catch { S.fx = null; } if (S.tab === "sync" || (S.tab === "settings" && (S.stab === "move" || (S.settings && !S.settings.miniflux.token)))) renderMain(); }
function noteImport(st) {
  const im = st && st.imported; if (!im || S.importSeen === im.at) return; const first = S.importSeen === undefined; S.importSeen = im.at;
  if (first && Date.now() - im.at > 20000) return; // an old import, from before this page opened
  toast(`Brought in ${im.events.toLocaleString()} reading-history change${im.events === 1 ? "" : "s"} from ${im.devices.join(", ") || "other machines"}.`, { kind: "success" });
}

// ---------- sync indicator ----------
let pollT = null, wasBusy = false;
const mfRed = () => !!(S.status && S.status.lights && S.status.lights.some(l => l.id === "miniflux" && l.state === "red"));
const isBusy = () => S.busy || !!(S.status && (S.status.activity || (S.status.pendingCount > 0 && !mfRed())));
async function pollSync() {
  pollT = null; try { S.status = await send({ type: "status" }); } catch { return; }
  const busy = isBusy(); renderIndicator();
  if (busy) { wasBusy = true; pollT = setTimeout(pollSync, 700); }
  else { clearPendingDots(); if (wasBusy && !mfRed()) { wasBusy = false; S.syncFlash = Date.now() + 2600; renderIndicator(); toastTimers.add(setTimeout(renderIndicator, 2700)); } else wasBusy = false; }
}
function kickSync() { if (!pollT) pollT = setTimeout(pollSync, 120); }
function clearPendingDots() { for (const r of S.rows.values()) if (r.pending) { r.pending = false; const el = rowElById(r.id); if (el) { el.dataset.pending = "false"; el.querySelector(".pdot")?.remove(); } } }
function pillEl() {
  const st = S.status; const overall = st ? st.overall : "off"; const a = st && st.activity; const pend = st ? st.pendingCount || 0 : 0;
  let state = "idle"; let text = overall === "green" ? (st && st.scope === "miniflux" ? "Miniflux in sync" : "In sync") : overall === "red" ? "Needs attention" : overall === "amber" ? "Catching up" : "Not set up"; let sub = ""; let lamp = h("span", { class: "lamp " + overall + (overall === "green" ? " pulse" : "") });
  if (a || S.busy) { state = "syncing"; text = a ? a.label : "Syncing with Miniflux"; sub = a && a.total ? `${Math.min(a.done, a.total)} of ${a.total}` : ""; lamp = h("span", { class: "spin" }); }
  else if (pend > 0 && !mfRed()) { state = "syncing"; text = "Sending to Miniflux"; sub = `${pend} waiting`; lamp = h("span", { class: "spin" }); }
  else if (S.syncFlash > Date.now()) { state = "synced"; text = "Synced with Miniflux"; lamp = icon("check", 14); }
  return h("button", { class: "pill", "data-state": state, title: st ? "Open the Sync page" : "", onclick: () => go("sync") }, lamp, h("span", { class: "ptext" }, text), sub ? h("span", { class: "sub2" }, sub) : null);
}
function progressEl() {
  const a = S.status && S.status.activity; const on = !!(a || S.busy); const det = !!(a && a.total > 0);
  return h("div", { class: "progress", role: "progressbar", "aria-label": "Syncing with Miniflux", "aria-hidden": on ? null : "true", "data-on": String(on), "data-mode": det ? "determinate" : "indeterminate" }, h("i", { style: det ? { width: Math.round(Math.min(1, a.done / a.total) * 100) + "%" } : {} }));
}
function renderIndicator() { const p = $app.querySelector(".pill"); if (p) p.replaceWith(pillEl()); const b = $app.querySelector(".progress"); if (b) b.replaceWith(progressEl()); }

// ---------- dialogs ----------
function dialogHost() { let d = document.querySelector(".dialogs"); if (!d) { d = h("div", { class: "dialogs" }); document.body.append(d); } return d; }
function closeDialog() { S.dialog = null; S.dialogCancel = null; dialogHost().replaceChildren(); }
function askConfirm({ title, body, confirmLabel = "OK", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    S.dialog = "confirm"; const done = (v) => { closeDialog(); resolve(v); }; S.dialogCancel = () => done(false);
    const ok = h("button", { class: "btn primary", "data-act": "confirm", onclick: () => done(true) }, confirmLabel);
    dialogHost().replaceChildren(h("div", { class: "overlay", onclick: () => done(false) }, h("div", { class: "dialog narrow", role: "alertdialog", "aria-label": title, onclick: (e) => e.stopPropagation() },
      h("h2", {}, title), h("p", {}, body), h("div", { class: "dfoot" }, h("button", { class: "btn", "data-act": "cancel", onclick: () => done(false) }, cancelLabel), ok))));
    ok.focus();
  });
}
const confirmIf = (kind, body) => { const m = U.confirmRead; return m === "never" || (m === "bulk" && kind === "single") ? Promise.resolve(true) : askConfirm({ title: "Mark as read?", body, confirmLabel: "Mark read" }); };

// ---------- actions ----------
function patchRow(r) {
  const el = rowElById(r.id); if (!el) return;
  el.dataset.read = String(r.read); el.dataset.saved = String(r.saved); el.dataset.pending = String(!!r.pending);
  const pd = el.querySelector(".pdot"); if (r.pending && !pd) { const nd = el.querySelector(".newdot"); if (nd) nd.after(h("span", { class: "pdot", title: "Sending to Miniflux" })); } else if (!r.pending && pd) pd.remove();
  const g = gradeOf(r.score); el.style.setProperty("--grade", g.bg); el.style.setProperty("--gfg", g.fg);
  const sc = el.querySelector(".score"); if (sc) sc.textContent = String(pct(g.d)); const bar = el.querySelector(".gbar i"); if (bar) bar.style.width = pct(g.d) + "%";
  const sv = el.querySelector("[data-act='save']"); if (sv) { sv.replaceChildren(icon("star", 17, r.saved)); sv.setAttribute("aria-pressed", String(r.saved)); sv.title = r.saved ? "Remove from saved (s)" : "Save (s)"; }
  const rd = el.querySelector("[data-act='read']"); if (rd) rd.textContent = r.read ? "Mark unread" : "Mark read";
  const cs = el.querySelector("[data-act='cardsave'] span"); if (cs) cs.textContent = r.saved ? "Saved" : "Save";
  const gr = groupOf(r.id); if (gr) updateGroupHead(gr);
}
function markRowsLocal(ids) {
  const fresh = ids.filter(id => S.rows.get(id) && !S.rows.get(id).read);
  for (const id of fresh) { const r = S.rows.get(id); r.read = true; r.pending = true; S.keep.add(id); patchRow(r); }
  return fresh;
}
function markRowsRead(ids, explicit = false) { if (!ids.length) return; markRowsLocal(ids); send({ type: "markRead", ids, explicit }); refreshChrome(); }
async function markUnread(id) { const r = S.rows.get(id); if (!r) return; r.read = false; r.pending = true; patchRow(r); send({ type: "markUnread", ids: [id] }); refreshChrome(); }
async function toggleRead(r) {
  if (r.read) return markUnread(r.id);
  if (!(await confirmIf("single", `Mark “${r.title}” as read?`))) return; markRowsRead([r.id], true);
}
async function undoRead(ids) {
  for (const id of ids) { const r = S.rows.get(id); if (r) { r.read = false; r.pending = true; patchRow(r); } }
  await send({ type: "markUnread", ids }); S.auto.clear(); toast(`Put ${ids.length} ${ids.length === 1 ? "article" : "articles"} back as unread.`, { kind: "success" }); refreshChrome(); if (isFeedTab()) loadView();
}
function reportRead(res) {
  if (!res || !res.count) return toast("Nothing to mark: everything here is already read.", { kind: "info" });
  const n = res.count; const word = n === 1 ? "article" : "articles"; const undo = res.ids && res.ids.length ? { label: "Undo", fn: () => undoRead(res.ids) } : null;
  if (res.verified && !res.retried) toast(`Marked ${n} ${word} read. Miniflux confirmed.`, { kind: "success", action: undo });
  else if (res.verified) toast(`Marked ${n} ${word} read. ${res.retried} needed a second try, and Miniflux now confirms all of them.`, { kind: "success", action: undo });
  else if (res.failed) toast(`Marked ${n} ${word} read here. ${res.failed} have not reached Miniflux yet and will be retried.`, { kind: "warn", action: { label: "Sync now", fn: syncNow } });
  else toast(`Marked ${n} ${word} read. Miniflux has not confirmed yet; the sync light will show if anything is left.`, { kind: "warn" });
}
// A bulk mark goes by scope, so it covers every unread article in the section or folder, not only the rows on screen.
async function bulkRead(rowIds, scope) {
  markRowsLocal(rowIds); refreshChrome();
  let res = null; try { res = await send(scope ? { type: "markScope", scope } : { type: "markRead", ids: rowIds, verify: true }); } catch { return null; }
  reportRead(res); return res;
}
async function saveRow(r) {
  if (r.indexOnly && !(await restoreRow(r))) return;
  r.saved = !r.saved; patchRow(r); const res = await send({ type: "save", id: r.id });
  if (res && res.saved) toast(res.tags && res.tags.length ? `Saved. Suggested tags: ${res.tags.join(", ")}.` : "Saved.", { kind: "success" }); refreshChrome();
}
function dismissRow(r) {
  const el = rowElById(r.id); const g = groupOf(r.id);
  if (S.openCard === r.id) closeCard(r, true);
  if (el) { el.style.maxHeight = el.offsetHeight + "px"; requestAnimationFrame(() => { el.dataset.leaving = "true"; }); setTimeout(() => el.remove(), 260); }
  if (g) { g.rows = g.rows.filter(x => x.id !== r.id); updateGroupHead(g); }
  S.rows.delete(r.id); if (S.data) S.data.dismissedCount = (S.data.dismissedCount || 0) + 1; const oldSub = $app.querySelector(".sub"); if (oldSub) oldSub.replaceWith(feedSub());
  send({ type: "dismiss", id: r.id }); toast("Dismissed. The feed's standing drops a little.", { kind: "info", action: { label: "Undo", fn: async () => { await send({ type: "undismissAll" }); S.auto.clear(); loadView(); } } }); refreshChrome();
}
// Background open: a real tab, counted as an open (the strongest everyday signal).
async function backgroundOpen(r) {
  r.read = true; S.keep.add(r.id); patchRow(r); await send({ type: "open", id: r.id }); toast("Opened in a background tab and counted as interest.", { kind: "success" }); refreshChrome();
}
async function fetchFull(r) {
  if (S.openCard !== r.id) await openCardFor(r);
  S.content[r.id] = { ...(S.content[r.id] || {}), loading: true }; fillCard(r);
  const res = await send({ type: "fetchFull", id: r.id });
  if (res && res.ok) { S.content[r.id] = { html: res.html, full: true }; toast("Full article loaded.", { kind: "success" }); }
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

// An article only the search index remembers is fetched from Miniflux again before it can be opened or saved.
async function restoreRow(r) {
  if (!r.indexOnly) return true;
  const ok = await send({ type: "restore", id: r.id });
  if (!ok) { toast("That article is no longer stored here and Miniflux could not be reached. Opening it on the web instead.", { kind: "warn" }); if (r.url) window.open(r.url, "_blank", "noopener"); return false; }
  r.indexOnly = false; const el = rowElById(r.id); el?.querySelector(".chip.idx")?.remove(); return true;
}
async function openCardFor(r) {
  if (S.openCard === r.id) return closeCard(r);
  if (r.indexOnly && !(await restoreRow(r))) return;
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
      h("button", { class: "btn small bionic" + (U.anchor ? " on" : ""), "data-act": "bionic", "aria-pressed": String(U.anchor), title: "Bionic reading: bold the start of each word (Shift+B)", onclick: toggleBionic }, h("b", {}, "B"), h("span", {}, "Bionic"), h("kbd", {}, "Shift+B")),
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
// Search terms are highlighted in titles and excerpts of the results.
function hl(text) {
  const terms = S.data && S.data.search ? (S.data.terms || []).filter(t => t.length > 1) : []; if (!terms.length || !text) return text;
  const re = new RegExp("(" + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "giu"); const out = []; let last = 0;
  text.replace(re, (m, _g, off) => { if (off > last) out.push(text.slice(last, off)); out.push(h("mark", {}, m)); last = off + m.length; return m; });
  if (last < text.length) out.push(text.slice(last)); return out.length ? out : text;
}
function rowEl(r) {
  const g = gradeOf(r.score); const ranked = S.ranked; const small = h("span", { class: "sep" }, "·");
  const meta = [ranked ? h("span", { class: "src" }, iconFor(r.feedId, r.feedTitle), " ", r.feedTitle) : null, r.author ? h("span", {}, r.author) : null, r.domain ? h("span", {}, r.domain) : null, h("span", { title: new Date(r.publishedAt).toLocaleString() }, ago(r.publishedAt)), r.readingTime ? h("span", {}, `${r.readingTime} min`) : null].filter(Boolean);
  const metaLine = []; meta.forEach((m, i) => { if (i) metaLine.push(h("span", { class: "sep" }, "·")); metaLine.push(m); });
  const chips = [r.indexOnly ? h("span", { class: "chip idx", title: "Only the search index remembers this article. Opening it fetches it from Miniflux again." }, icon("clock", 12), "Archive") : null, r.newish && !r.read ? h("span", { class: "chip ok" }, "New") : null, r.media ? h("span", { class: "chip" }, icon(r.media === "audio" ? "music" : "play", 12), r.media === "audio" ? "Audio" : "Video") : null,
    r.comments ? h("a", { class: "chip", href: r.comments, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, icon("msg", 12), "Comments") : null,
    r.flag ? h("span", { class: "chip warn" }, "Serendipity") : null, r.words && r.words < 150 && !r.media ? h("span", { class: "chip", title: "This feed sends only an excerpt. Press w to fetch the full article." }, icon("coffee", 12), "Excerpt") : null,
    ...(r.tags || []).slice(0, 3).map(t => h("span", { class: "chip tag" }, "#" + t))].filter(Boolean);
  const act = (name, ic, title, fn, cls = "") => h("button", { class: "ibtn " + cls, "data-act": name, title, "aria-label": title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 17, name === "save" && r.saved));
  return h("article", { class: "row", data: { id: r.id, read: String(r.read), saved: String(r.saved), sel: String(S.selId === r.id), card: "false", pending: String(!!r.pending) }, style: { "--grade": g.bg, "--gfg": g.fg }, onclick: () => selectRow(r.id) },
    h("span", { class: "strip", "aria-hidden": "true" }),
    h("div", { class: "rmain" },
      h("div", { class: "rmeta" }, h("span", { class: "newdot", title: "Unread" }), r.pending ? h("span", { class: "pdot", title: "Sending to Miniflux" }) : null, metaLine),
      h("button", { class: "rtitle", onclick: (e) => { e.stopPropagation(); openCardFor(r); } }, hl(r.title)),
      r.summary ? h("div", { class: "rsnip" }, hl(r.summary)) : null, chips.length ? h("div", { class: "chips" }, chips) : null),
    h("div", { class: "rside" }, U.thumbs && r.thumb ? h("img", { class: "thumb", src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      h("div", { class: "grade", title: `Relevance ${pct(g.d)} of 100 (raw ${pct(r.score)}; ${r.why})` }, h("span", { class: "score" }, String(pct(g.d))), h("div", { class: "gbar" }, h("i", { style: { width: pct(g.d) + "%" } })))),
    h("div", { class: "acts" }, act("save", "star", r.saved ? "Remove from saved (s)" : "Save (s)", () => saveRow(r), "save"), act("bg", "ext", "Open in a background tab (b)", () => backgroundOpen(r)),
      act("full", "coffee", "Fetch the full article (w)", () => fetchFull(r)), act("dismiss", "x", "Dismiss (x)", () => dismissRow(r)), act("card", "down", "Read here (o)", () => openCardFor(r))),
    h("div", { class: "cardwrap" }, h("div", { class: "cardin" })));
}
function groupHead(g) {
  if (g.search) return h("header", { class: "ghead", "data-search": "true" }, h("span", { class: "chev" }, icon("search", 16)), h("span", { class: "gtitle" }, `Results for “${S.q.trim()}”`), h("span", { class: "gunread" }, `${g.rows.length} found`));
  const unread = g.rows.filter(r => !r.read); const top = unread.slice().sort((a, b) => b.score - a.score).slice(0, 14);
  const done = unread.length === 0;
  const first = g.rows[0];
  return h("header", { class: "ghead" },
    h("button", { class: "gtoggle", "aria-expanded": String(!isCollapsed(g.key)), onclick: () => toggleGroup(g) },
      h("span", { class: "chev" }, icon("chev", 16)), g.feedId ? iconFor(g.feedId, g.title) : icon("bolt", 16), h("span", { class: "gtitle" }, g.title),
      h("span", { class: "gunread" + (done ? " zero" : "") }, done ? "all read" : `${unread.length} unread`), done ? h("span", { class: "gdone", title: "Read through" }, icon("check", 16)) : null,
      h("span", { class: "ticks", "aria-hidden": "true", title: "Relevance of the unread articles" }, top.map(r => { const gg = gradeOf(r.score); return h("i", { style: { "--c": gg.bg, "--h": Math.max(4, Math.round(4 + gg.d * 10)) + "px" } }); }))),
    h("button", { class: "btn small ghost", title: "Mark the section read (Shift+A)", disabled: unread.length ? null : true, onclick: () => markSectionRead(g) }, icon("check", 15), "Mark section read"),
    h("span", { class: "gprog", role: "progressbar", "aria-label": "Read in this section", "aria-valuemin": "0", "aria-valuemax": String(g.rows.length), "aria-valuenow": String(g.rows.length - unread.length) }, h("i", { style: { width: (g.rows.length ? Math.round((g.rows.length - unread.length) / g.rows.length * 100) : 0) + "%" } })));
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
const foldGroup = (g) => { S.auto.add(g.key); if (g.el) { g.el.dataset.collapsed = "true"; g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", "false"); } if (S.openCard && g.rows.some(r => r.id === S.openCard)) closeCard(S.rows.get(S.openCard), true); };
const plural = (n) => `${n} ${n === 1 ? "article" : "articles"}`;
// Marking a whole section read is the "read through" signal, so the section folds away.
async function markSectionRead(g) {
  if (!g || g.search) return; const unread = g.rows.filter(r => !r.read); if (!unread.length) return;
  const scope = g.feedId && !S.ranked ? "feed:" + g.feedId : null; const node = scope && S.tree.find(x => x.id === scope); const n = Math.max(unread.length, node ? node.unread : 0);
  if (!(await confirmIf("bulk", `Mark ${plural(n)} in “${g.title}” as read?`))) return;
  setTimeout(() => foldGroup(g), 380); await bulkRead(unread.map(r => r.id), scope);
}
async function markAllRead() {
  if (!S.data || S.data.search) return; const ids = []; for (const g of S.data.groups) for (const r of g.rows) if (!r.read) ids.push(r.id);
  const scope = S.tab === "saved" ? null : S.scope; const node = scope && scope !== "all" ? S.tree.find(x => x.id === scope) : null;
  const n = Math.max(ids.length, scope === "all" ? S.unread : node ? node.unread : 0); if (!n) return toast("Nothing to mark: everything here is already read.", { kind: "info" });
  const where = !scope || scope === "all" ? "in every folder" : `in “${node ? node.label : "this folder"}”`;
  if (!(await confirmIf("bulk", `Mark all ${plural(n)} ${where} as read?`))) return;
  setTimeout(() => { for (const g of S.data.groups) foldGroup(g); }, 380); await bulkRead(ids, scope);
}
// The section Shift+A acts on: the selected row's, else the first one on screen that still has unread articles.
function currentGroup() {
  const sel = S.rows.get(S.selId); const g = sel && groupOf(sel.id); if (g) return g;
  const topH = Number(getComputedStyle(document.documentElement).getPropertyValue("--ghead-top").replace("px", "")) || 100;
  return S.data.groups.find(x => x.el && !isCollapsed(x.key) && x.rows.some(r => !r.read) && x.el.getBoundingClientRect().bottom > topH) || S.data.groups.find(x => x.rows.some(r => !r.read)) || null;
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
const clearSearch = () => { S.q = ""; const i = $app.querySelector(".search input"); if (i) i.value = ""; loadView(); };
async function searchServerNow() {
  const r = await send({ type: "searchServer", q: S.q }); toast(r.sentence, { kind: r.ok ? "success" : "warn" }); if (r.ok) loadSearch();
}
function searchSub() {
  const d = S.data;
  return h("div", { class: "sub" }, h("h1", {}, "Search"), h("span", { class: "meta" }, `${d.total} found among ${d.indexSize} articles remembered on this machine`),
    h("div", { class: "seg", role: "group", "aria-label": "Search in" }, [["all", "Everything"], ["unread", "Unread"], ["read", "Read"], ["saved", "Saved"]].map(([id, l]) => h("button", { "aria-pressed": String(S.searchIn === id), onclick: () => { S.searchIn = id; loadView(); } }, l))),
    h("button", { class: "btn", title: "Ask Miniflux for older articles that match", onclick: searchServerNow }, icon("search", 15), "Search Miniflux for older"),
    h("button", { class: "btn ghost", onclick: clearSearch }, icon("x", 15), "Clear"));
}
const tips = () => h("details", { class: "tips" }, h("summary", {}, "Search tips"), h("p", {}, "Words are matched loosely, so a misspelling or a different word ending still finds the article. Every word has to match."),
  h("p", {}, h("code", {}, "#navy"), " matches a tag. ", h("code", {}, "feed:naval"), " limits to one feed. ", h("code", {}, "\"exact phrase\""), " keeps words together. ", h("code", {}, "-word"), " leaves matches out. ", h("code", {}, "in:read"), ", ", h("code", {}, "in:unread"), " or ", h("code", {}, "in:saved"), " pick a state. ", h("code", {}, "since:30d"), " limits to the last 30 days."));
function feedSub() {
  if (S.data && S.data.search) return searchSub();
  const d = S.data; const title = S.tab === "saved" ? "Saved" : S.scope === "all" ? "Newsfeed" : (S.tree.find(n => n.id === S.scope) || {}).label || "Newsfeed";
  const allCollapsed = d && d.groups.length && d.groups.every(g => isCollapsed(g.key));
  const sub = h("div", { class: "sub" }, h("h1", {}, title), h("span", { class: "meta" }, d ? `${d.unreadTotal} unread in total · ${d.total} shown` : ""),
    h("div", { class: "seg", role: "group", "aria-label": "Show" }, h("button", { "aria-pressed": String(S.mode === "unread"), onclick: () => { S.mode = "unread"; S.keep = new Set(); loadView(); } }, "Unread"), h("button", { "aria-pressed": String(S.mode === "all"), onclick: () => { S.mode = "all"; loadView(); } }, "All")),
    h("button", { class: "btn" + (S.ranked ? " on" : ""), title: "Sort every feed together by relevance", "aria-pressed": String(S.ranked), onclick: () => { S.ranked = !S.ranked; loadView(); } }, icon("bolt", 15), "Ranked"),
    h("div", { class: "seg", role: "group", "aria-label": "Density" }, h("button", { title: "Compact list", "aria-pressed": String(U.density === "compact"), onclick: () => { setPref({ density: "compact" }); render(); } }, icon("list", 15)), h("button", { title: "Comfortable list with excerpts and thumbnails", "aria-pressed": String(U.density !== "compact"), onclick: () => { setPref({ density: "comfortable" }); render(); } }, icon("grid", 15))),
    h("button", { class: "btn" + (U.scrollRead ? " on" : ""), title: "Mark articles read as they scroll past the top of the screen", "aria-pressed": String(U.scrollRead), onclick: () => { setPref({ scrollRead: !U.scrollRead }); toast(U.scrollRead ? "Articles are marked read once they scroll past the top." : "Scroll marking is off."); renderMain(); } }, icon("scroll", 15), "Read on scroll"),
    h("button", { class: "btn", title: allCollapsed ? "Expand every feed (Shift+C)" : "Collapse every feed (Shift+C)", onclick: () => { setAllGroups(!allCollapsed); renderMain(); } }, icon(allCollapsed ? "down2" : "up2", 15), allCollapsed ? "Expand all" : "Collapse all"),
    h("button", { class: "btn", title: "Mark everything unread here as read (Shift+M)", disabled: d && d.groups.some(g => g.rows.some(r => !r.read)) ? null : true, onclick: markAllRead }, icon("check", 15), "Mark all read"),
    d && d.dismissedCount ? h("button", { class: "btn ghost", onclick: async () => { await send({ type: "undismissAll" }); loadView(); } }, icon("undo", 15), `Undo dismissed (${d.dismissedCount})`) : null);
  return sub;
}
function feedMain() {
  const d = S.data;
  const sub = feedSub();
  if (d && d.search) {
    const body = h("div", { class: "feeds density-" + (U.density === "compact" ? "compact" : "comfortable") }, d.groups.length ? d.groups.map(groupEl)
      : h("div", { class: "empty" }, h("div", { class: "t" }, d.empty ? "Type something to search" : "Nothing matches"), h("div", {}, d.empty ? "Use words, #tags, feed: names or quotes." : "Try fewer words, or ask Miniflux for older articles with the button above.")), tips());
    return [sub, body];
  }
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
  else if (tab === "sync") Promise.all([send({ type: "status" }), send({ type: "stats" })]).then(([st, sa]) => { S.status = st; S.stats = sa; render(); loadFx(); });
  else { S.draft = null; render(); }
}
function topBar() {
  const themeIcon = { light: icon("sun"), dark: icon("moon"), oled: icon("moon", 18, true), auto: icon("clock") }[U.theme];
  return h("header", { class: "top" }, progressEl(),
    h("button", { class: "ibtn", title: "Show or hide the folder list", "aria-label": "Toggle folders", onclick: () => { setPref({ side: !U.side }); renderChrome(); } }, icon("menu", 20)),
    h("div", { class: "brand" }, h("img", { src: "../icons/icon-32.png", alt: "" }), "Pravaha"),
    h("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" }, TABS.map(([id, label, ic]) => h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === id), onclick: () => go(id) }, icon(ic, 16), h("span", { class: "lbl" }, label), id === "feed" && S.unread ? h("span", { class: "count" }, S.unread > 999 ? "999+" : S.unread) : null))),
    h("div", { class: "grow" }),
    isFeedTab() ? h("label", { class: "search" }, icon("search", 15), h("input", { type: "search", placeholder: "Search everything  ( / )", "aria-label": "Search articles", value: S.q, oninput: debounce((e) => { S.q = e.target.value; loadView(); }, 260) })) : null,
    h("button", { class: "ibtn bionic", "aria-pressed": String(U.anchor), title: "Bionic reading: bold the start of each word (Shift+B)", "aria-label": "Bionic reading", onclick: toggleBionic }, h("b", {}, "B"), h("span", {}, "r")),
    h("button", { class: "ibtn aa", title: "Reading type", "aria-label": "Reading type", "aria-expanded": String(S.pop === "aa"), onclick: (e) => { e.stopPropagation(); S.pop = S.pop === "aa" ? null : "aa"; renderPop(); } }, "Aa"),
    h("button", { class: "ibtn", title: `Theme: ${THEME_NAMES[U.theme]}. Click to change.`, "aria-label": "Change theme", onclick: () => { setPref({ theme: THEMES[(THEMES.indexOf(U.theme) + 1) % THEMES.length] }); renderChrome(); toast("Theme: " + THEME_NAMES[U.theme]); } }, themeIcon),
    h("button", { class: "ibtn", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: () => { S.help = true; renderOverlay(); } }, icon("help")),
    pillEl());
}
function sideBar() {
  const byId = new Map(S.tree.map(n => [n.id, n]));
  const hidden = (n) => { for (let p = n.parent && byId.get(n.parent); p; p = p.parent && byId.get(p.parent)) if (S.treeCollapsed.has(p.id)) return true; return false; };
  const hasKids = (n) => S.tree.some(x => x.parent === n.id);
  const rows = S.tree.filter(n => !hidden(n)).map(n => {
    const chev = n.type === "folder" && hasKids(n) ? h("button", { class: "chev", "aria-label": (S.treeCollapsed.has(n.id) ? "Expand " : "Collapse ") + n.label, "aria-expanded": String(!S.treeCollapsed.has(n.id)), onclick: () => { S.treeCollapsed.has(n.id) ? S.treeCollapsed.delete(n.id) : S.treeCollapsed.add(n.id); lsSet("pravaha.treeCollapsed", [...S.treeCollapsed]); renderChrome(); } }, icon("chev", 14)) : h("span", { class: "chev" });
    const cur = S.tab === "feed" && S.scope === n.id;
    const mv = S.reorder ? h("span", { class: "mv" },
      h("button", { title: "Move up", "aria-label": "Move " + n.label + " up", "data-mv": "up", disabled: n.first ? true : null, onclick: () => moveNode(n.id, "up") }, icon("up", 14)),
      h("button", { title: "Move down", "aria-label": "Move " + n.label + " down", "data-mv": "down", disabled: n.last ? true : null, onclick: () => moveNode(n.id, "down") }, icon("down", 14))) : null;
    return h("div", { class: "trow", "data-id": n.id, style: { paddingLeft: n.depth * 14 + "px" } }, chev, h("button", { class: "tbtn", "aria-current": cur ? "true" : null, onclick: () => { S.scope = n.id; if (S.tab !== "feed") { S.tab = "feed"; lsSet("pravaha.tab", "feed"); } S.keep = new Set(); loadView(); } },
      n.type === "feed" ? iconFor(Number(n.id.slice(5)), n.label) : null, h("span", { class: "lbl" }, n.label), n.state && n.state !== "green" ? h("span", { class: "dot " + n.state, title: "This feed has trouble in Miniflux" }) : null, n.unread ? h("span", { class: "n" }, n.unread) : null), mv);
  });
  return h("aside", { class: "side", "aria-label": "Folders and feeds", data: { reorder: String(S.reorder) } },
    h("div", { class: "sidehead" }, h("span", { class: "grow" }, S.reorder ? "Reordering" : "Folders"),
      h("button", { class: "ibtn", "data-act": "addfeed", title: "Add a feed from a website (a)", "aria-label": "Add a feed", onclick: () => openAddFeed() }, icon("plus", 18)),
      h("button", { class: "ibtn" + (S.reorder ? " on" : ""), "data-act": "reorder", title: S.reorder ? "Finish reordering" : "Reorder folders and feeds", "aria-label": S.reorder ? "Finish reordering" : "Reorder folders and feeds", "aria-pressed": String(S.reorder), onclick: toggleReorder }, icon("swap", 17))),
    h("div", { class: "trow" }, h("span", { class: "chev" }), h("button", { class: "tbtn", "aria-current": S.tab === "feed" && S.scope === "all" ? "true" : null, onclick: () => { S.scope = "all"; S.tab = "feed"; lsSet("pravaha.tab", "feed"); S.keep = new Set(); loadView(); } }, icon("list", 16), h("span", { class: "lbl" }, "All articles"), S.unread ? h("span", { class: "n" }, S.unread) : null)),
    rows);
}
const reloadGroups = debounce(() => { if (isFeedTab()) loadView(); }, 500);
async function moveNode(id, dir) { const r = await send({ type: "moveNode", id, dir }); if (r && r.tree) { S.tree = r.tree; renderChrome(); if (r.moved) reloadGroups(); } }
function toggleReorder() { S.reorder = !S.reorder; renderChrome(); if (S.reorder) toast("Reorder mode. Use the arrows beside a folder or feed, then press the button again to finish.", { kind: "info" }); }
function toggleBionic() { setPref({ anchor: !U.anchor }); renderChrome(); toast(U.anchor ? "Bionic reading is on." : "Bionic reading is off.", { kind: "info" }); }
// A redraw must not take the cursor out of the search box while someone is typing in it.
function keepSearchFocus(fn) {
  const a = document.activeElement; const keep = a && a.matches && a.matches(".search input") ? a.selectionStart : null; fn();
  if (keep !== null) { const i = $app.querySelector(".search input"); if (i) { i.focus(); try { i.setSelectionRange(keep, keep); } catch { /* ignore */ } } }
}
function renderChrome() {
  noteImport(S.status);
  const body = $app.querySelector(".body"); if (!body) return render();
  keepSearchFocus(() => { $app.querySelector(".top")?.replaceWith(topBar()); const side = body.querySelector(".side"); if (side) side.replaceWith(sideBar()); body.dataset.side = U.side ? "on" : "off"; });
}
// Apple fonts are built locally and may be absent. Until the probe answers (or where the browser cannot probe) a font counts as present.
const fontOk = {};
function probeFonts() {
  for (const [id, info] of Object.entries(FONT_INFO)) {
    if (!info.apple || !document.fonts || !document.fonts.load) continue;
    document.fonts.load(`400 16px "${info.apple}"`).then((r) => { fontOk[id] = r.length > 0; }, () => { fontOk[id] = false; }).then(() => { if (S.pop === "aa") renderPop(); if (S.tab === "settings") renderMain(); });
  }
}
const fontHere = (id) => fontOk[id] !== false;
const infoOf = (id, ui) => ui && id === "system" ? { kind: "sans", note: "Whatever sans-serif your computer provides." } : FONT_INFO[id] || { kind: "sans", note: "" };
function fontPicker(list, key, cssVar, sample) {
  const ui = cssVar === "ui";
  const card = ([id, label]) => {
    const info = infoOf(id, ui); const ok = fontHere(id); const fam = `var(--${cssVar}-${id})`;
    return h("button", { class: "fontcard", "aria-pressed": String(U[key] === id), disabled: !ok, title: ok ? label : label + " is not in this build", onclick: () => { setPref({ [key]: id }); renderMain(); } },
      h("span", { class: "fname", style: { fontFamily: fam } }, label, U[key] === id ? h("i", {}, "In use") : null),
      h("span", { class: "fsample", style: { fontFamily: fam } }, sample),
      h("span", { class: "fnote" }, ok ? info.note : "Not in this build. Run tools/apple-fonts.py, then rebuild."));
  };
  const serif = list.filter(([id]) => infoOf(id, ui).kind === "serif"), sans = list.filter(([id]) => infoOf(id, ui).kind !== "serif");
  return h("div", { class: "fonts" }, serif.length ? [h("div", { class: "fonthead" }, "Serif: the classic choice for long articles"), ...serif.map(card)] : null, sans.length ? [h("div", { class: "fonthead" }, "Sans: clean and compact"), ...sans.map(card)] : null);
}
function fontSelect(list, key, onpick) {
  const opt = ([id, l]) => h("option", { value: id, selected: U[key] === id, disabled: !fontHere(id), style: { fontFamily: `var(--${key === "readFont" ? "serif" : "ui"}-${id})` } }, fontHere(id) ? l : l + " (not in this build)");
  const g = (kind, title) => { const items = list.filter(([id]) => (infoOf(id, key === "uiFont").kind === "serif") === (kind === "serif")); return h("optgroup", { label: title }, items.map(opt)); };
  return h("select", { "aria-label": key === "readFont" ? "Reading font" : "Interface font", onchange: (e) => onpick(e.target.value) }, g("serif", "Serif"), g("sans", "Sans"));
}
function range(label, key, lo, hi, step, fmt = (v) => v) {
  const out = h("span", {}, fmt(U[key]));
  return h("label", { class: "range" }, h("span", {}, label), h("input", { type: "range", min: lo, max: hi, step, value: U[key], oninput: (e) => { setPref({ [key]: Number(e.target.value) }); out.textContent = fmt(U[key]); } }), out);
}
function renderPop() {
  $app.querySelector(".pop")?.remove(); if (S.pop !== "aa") return;
  $app.append(h("div", { class: "pop", role: "dialog", "aria-label": "Reading type", onclick: (e) => e.stopPropagation() },
    fontSelect(READ_FONTS, "readFont", (v) => { setPref({ readFont: v }); renderPop(); }),
    range("Size", "readSize", 15, 26, 1, (v) => v + "px"), range("Line gap", "readLine", 1.3, 2, 0.05, (v) => Number(v).toFixed(2)), range("Width", "readWidth", 46, 90, 2, (v) => v + "ch"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: U.anchor, onchange: (e) => { setPref({ anchor: e.target.checked }); renderPop(); } }), "Bionic reading (Shift+B)"),
    range("Strength", "anchorLevel", 1, 5, 1, (v) => ["", "Lightest", "Light", "Medium", "Strong", "Strongest"][v]),
    h("p", { class: "prose", "data-sample": "The quick brown fox reads the morning news, one calm paragraph at a time.", style: { margin: 0, fontSize: "calc(var(--read-size) * .9)" } }, "The quick brown fox reads the morning news, one calm paragraph at a time.")));
  anchorSamples();
}
document.addEventListener("click", (e) => { if (S.pop && !e.target.closest(".pop") && !e.target.closest(".aa")) { S.pop = null; renderPop(); renderChrome(); } });
const SHORTCUTS = [["j / k", "Next or previous article (opens it if a card is open)"], ["o or Enter", "Read here as a card"], ["b", "Open in a background tab, counted as interest"], ["w", "Fetch the full article (the coffee button)"], ["s", "Save or unsave"], ["x", "Dismiss"], ["m", "Mark read or unread"], ["Shift+A", "Mark the section read and fold it (works without a selection)"], ["Shift+M", "Mark everything in this view read"], ["Shift+B", "Bionic reading on or off"], ["a", "Add a feed from a website"], ["c", "Fold or unfold the section"], ["Shift+C", "Fold or unfold every section"], ["u", "Switch between Unread and All"], ["r", "Sync now"], ["/", "Search"], ["Esc", "Close the card or this panel"], ["?", "Show this list"]];
function renderOverlay() {
  $app.querySelector(".overlay")?.remove(); if (!S.help) return;
  $app.append(h("div", { class: "overlay", onclick: () => { S.help = false; renderOverlay(); } }, h("div", { class: "dialog", role: "dialog", "aria-label": "Keyboard shortcuts", onclick: (e) => e.stopPropagation() }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, d]) => h("div", {}, h("span", {}, d), h("kbd", {}, k)))), h("p", { class: "note", style: { marginTop: "12px" } }, "Shortcuts pause while you type in a box."))));
}

// ---------- main area ----------
function render() {
  const view = isFeedTab() ? feedMain() : S.tab === "stats" ? statsMain() : S.tab === "sync" ? syncMain() : settingsMain();
  const body = h("div", { class: "body", "data-side": U.side ? "on" : "off" }, sideBar(), h("main", { class: "main" }, view));
  keepSearchFocus(() => { $app.replaceChildren(topBar(), body); renderPop(); renderOverlay(); afterMain(); });
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
      st.activity ? h("p", { class: "note" }, `${st.activity.label}${st.activity.total ? `: ${Math.min(st.activity.done, st.activity.total)} of ${st.activity.total}` : ""}`) : null,
      h("button", { class: "btn primary", onclick: syncNow }, icon("sync", 15), S.busy ? "Syncing" : "Sync now"), h("button", { class: "btn", onclick: async () => { const r = await send({ type: "digest" }); toast(r.sentence); } }, "Write digest now")),
    h("div", { class: "panel" }, lights), h("div", { class: "panel" }, h("h2", {}, "Changes waiting over time"), spark), fxCard())];
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
  const patch = { miniflux: d.miniflux, webdav: d.webdav, raindrop: d.raindrop, weights: d.weights, novelty: d.novelty, pollMinutes: Number(d.pollMinutes) || 2, retentionDays: Number(d.retentionDays) || 30, autoTag: d.autoTag, saveToRaindrop: d.saveToRaindrop, autoDigest: d.autoDigest, device: (d.device || S.settings.device || "").trim() || S.settings.device };
  S.settings = await send({ type: "saveSettings", patch }); S.draft = null; ensureDraft(); S.dirty = false;
  const b = $app.querySelector(".savebar [data-save]"); if (b) b.disabled = true; const t = $app.querySelector(".savebar .note"); if (t) t.textContent = granted ? "Saved. Testing each connection now." : "Saved, but Firefox did not allow your custom server.";
  const results = await Promise.all(["miniflux", "webdav", "raindrop"].filter(w => complete(w, S.draft)).map(w => runTest(w, false)));
  if (t && S.draft.miniflux.token) t.textContent = results.every(Boolean) ? "Saved. Every connection answered." : "Saved. See the lights above for any connection that needs a fix.";
  if (results[0]) { const go1 = $app.querySelector("[data-gofeed]"); if (go1) go1.hidden = false; }
}
// Shown on a machine with no keys: the three ways to set it up, with what Firefox Sync holds right now.
function setupHero() {
  const fx = S.fx; const found = fx ? fx.parts.filter(p => p.remote) : []; const by = found.length ? found[0].remote.by : "";
  const fxText = !fx ? "Looking in Firefox Sync." : !fx.readable ? "Firefox Sync storage could not be read in this browser." : found.length ? `Found a setup saved${by ? ` by ${by}` : ""} ${since(Math.max(...found.map(p => p.remote.at)))}. It is applied automatically; if it has not appeared, press Fetch.` : "Nothing yet. On your other machine open Settings, Move setup and press Send. Firefox Sync must be signed in here with Add-ons ticked, and can take a few minutes.";
  return h("div", { class: "hero setup" }, h("h2", {}, "Set up this machine"),
    h("p", {}, "Pick whichever is easiest. Everything arrives the same way: keys first, then your articles from Miniflux, then your reading history from the WebDAV storage."),
    h("div", { class: "routes" },
      h("div", { class: "route", "data-route": "firefox-sync" }, h("h3", {}, "1. From Firefox Sync"), h("p", {}, fxText), h("button", { class: "btn", "data-act": "fx-pull", onclick: () => fxAct("pull", false) }, "Check Firefox Sync now")),
      h("div", { class: "route", "data-route": "file" }, h("h3", {}, "2. From a settings file"), h("p", {}, "Made on your other machine with Settings, Move setup, Export."), h("button", { class: "btn", "data-act": "go-move", onclick: () => { S.stab = "move"; renderMain(); } }, "Import a file")),
      h("div", { class: "route", "data-route": "type" }, h("h3", {}, "3. Type the keys"), h("p", {}, "Paste your Miniflux address and API key below. Each connection is tested as soon as its boxes are filled."))));
}

function settingsMain() {
  const d = ensureDraft(); const tab = S.stab;
  const inp = (label, obj, key, type = "text", w = null, ph = "") => h("label", { class: "field" }, label, h("input", { type, value: obj[key] ?? "", placeholder: ph, autocomplete: "off", spellcheck: "false", oninput: (e) => { obj[key] = type === "number" ? Number(e.target.value) : e.target.value; markDirty(); if (w) queueTest(w); } }));
  const sel = (label, opts, val, fn) => h("label", { class: "field" }, label, h("select", { onchange: (e) => fn(e.target.value) }, opts.map(([v, l]) => h("option", { value: v, selected: v === val }, l))));
  const chk = (label, obj, key, after) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; if (after) after(e.target.checked); else markDirty(); } }), label);
  const conn = (w, fields, help) => h("div", { class: "conn" }, h("h3", {}, SVC[w]), ...fields, h("div", { class: "res " + ((S.tests[w] || {}).state || "idle"), "data-test": w }, (S.tests[w] || {}).sentence ? [h("span", { class: "lamp " + (S.tests[w].state === "ok" ? "green" : S.tests[w].state === "bad" ? "red" : "off"), style: { marginTop: "4px" } }), h("span", {}, S.tests[w].sentence)] : h("span", { class: "note" }, help)),
    h("div", {}, h("button", { class: "btn small", onclick: () => runTest(w, true) }, "Test now")));
  let content;
  if (tab === "connections") content = [h("div", { class: "conns" },
    conn("miniflux", [inp("Server address", d.miniflux, "url", "text", "miniflux"), inp("API key", d.miniflux, "token", "password", "miniflux")], "Miniflux, Settings, API Keys. Tested as soon as both boxes are filled."),
    conn("webdav", [inp("Server address", d.webdav, "url", "text", "webdav"), inp("User name", d.webdav, "user", "text", "webdav"), inp("App password", d.webdav, "pass", "password", "webdav"), inp("Folder", d.webdav, "root", "text", "webdav")], "Fastmail app password with Files access. The test writes a small file."),
    conn("raindrop", [inp("API token", d.raindrop, "token", "password", "raindrop")], "Optional. Gives tag suggestions and one-way saving.")),
    h("p", { class: "note" }, "Keys, settings and look travel between your machines through Firefox Sync by themselves. See ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); S.stab = "move"; renderMain(); } }, "Move setup"), " to check, send or fetch them, or to use a settings file instead."), chk("Save starred articles to Raindrop", d, "saveToRaindrop"), chk("Suggest tags from my Raindrop tags", d, "autoTag")];
  else if (tab === "look") content = [h("div", { class: "panel" }, h("h2", {}, "Look"),
    h("div", { class: "grid2" }, h("div", { class: "field" }, "Theme", h("div", { class: "seg" }, THEMES.map(t => h("button", { "aria-pressed": String(U.theme === t), onclick: (e) => { setPref({ theme: t }); renderMain(); renderChrome(); } }, THEME_NAMES[t].split(" ")[0])))),
      h("div", { class: "field" }, "Relevance colours", h("div", { class: "seg" }, ["ember", "saffron", "moss"].map(p => h("button", { "aria-pressed": String(U.palette === p), onclick: () => { setPref({ palette: p }); renderMain(); } }, p[0].toUpperCase() + p.slice(1))))),
      h("div", { class: "field" }, "Density", h("div", { class: "seg" }, [["compact", "Compact"], ["comfortable", "Comfortable"]].map(([id, l]) => h("button", { "aria-pressed": String((U.density === "compact") === (id === "compact")), onclick: () => { setPref({ density: id }); renderMain(); } }, l))))),
    chk("Show thumbnails (these load from the publisher's site)", U, "thumbs", (v) => { setPref({ thumbs: v }); }), chk("Mark articles read as they scroll past the top", U, "scrollRead", (v) => { setPref({ scrollRead: v }); })),
    h("div", { class: "panel" }, h("h2", {}, "Marking read"),
      h("div", { class: "grid2" }, sel("Ask before marking read", CONFIRM_MODES, U.confirmRead, (v) => setPref({ confirmRead: v }))),
      h("p", { class: "note" }, "Sections and mark all is the default: a single article never asks, a whole section or folder does. Scrolling past an article never asks, and a bulk mark can always be undone from its message.")),
    h("div", { class: "panel" }, h("h2", {}, "Fonts"),
      h("div", { class: "field" }, "Reading font (articles and cards)", fontPicker(READ_FONTS, "readFont", "serif", "Reading is calmer when the type is.")),
      h("div", { class: "field", style: { marginTop: "14px" } }, "Interface font (menus, lists and buttons)", fontPicker(UI_FONTS, "uiFont", "ui", "Newsfeed, Saved, Stats 0123456789"))),
    h("div", { class: "panel" }, h("h2", {}, "Reading type"),
      range("Size", "readSize", 15, 26, 1, (v) => v + "px"), range("Line gap", "readLine", 1.3, 2, 0.05, (v) => Number(v).toFixed(2)), range("Width", "readWidth", 46, 90, 2, (v) => v + "ch"),
      chk("Bionic reading: bold the start of each word (English and other Latin text)", U, "anchor", (v) => { setPref({ anchor: v }); renderChrome(); renderMain(); }), range("Bionic strength", "anchorLevel", 1, 5, 1, (v) => ["", "Lightest", "Light", "Medium", "Strong", "Strongest"][v]),
      h("div", { class: "sample prose" }, h("p", { "data-sample": "Reading is a daily discipline. A comfortable measure, a generous line gap and a calm serif let a long article carry you along without effort." }, "Reading is a daily discipline. A comfortable measure, a generous line gap and a calm serif let a long article carry you along without effort."), h("p", { "data-sample": "Changes apply instantly and stay on this machine." }, "Changes apply instantly and stay on this machine.")))];
  else if (tab === "ranking") content = [h("div", { class: "panel" }, h("h2", {}, "Relevance weights"), ...[["tag", "Tag match"], ["echo", "Sites you read"], ["authority", "Feed standing"], ["freshness", "Freshness"]].map(([k, l]) => { const out = h("span", {}, pct(d.weights[k])); return h("label", { class: "range" }, h("span", {}, l), h("input", { type: "range", min: 0, max: 1, step: 0.05, value: d.weights[k], oninput: (e) => { d.weights[k] = Number(e.target.value); out.textContent = pct(d.weights[k]); markDirty(); } }), out); }),
    h("p", { class: "note" }, "Only the proportions matter. They are rescaled to add up to one when saved."), chk("Boost feeds I have not opened this session", d, "novelty"))];
  else if (tab === "move") content = moveMain();
  else if (tab === "machine") content = [h("div", { class: "panel" }, h("h2", {}, "This machine"), h("div", { class: "grid2" }, inp("Machine name (set once, keep it)", d, "device"), inp("Check for new articles every (minutes)", d, "pollMinutes", "number"), inp("Keep read articles for (days)", d, "retentionDays", "number")), chk("Write the weekly digest automatically", d, "autoDigest"))];
  else content = [h("div", { class: "panel" }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, v]) => h("div", {}, h("span", {}, v), h("kbd", {}, k)))))];
  const needSave = tab === "connections" || tab === "ranking" || tab === "machine";
  return [h("div", { class: "page" }, h("h1", {}, "Settings"),
    S.settings && !S.settings.miniflux.token ? setupHero() : null,
    h("div", { class: "stabs", role: "tablist" }, [["connections", "Connections"], ["look", "Look and reading"], ["ranking", "Ranking"], ["move", "Move setup"], ["machine", "This machine"], ["keys", "Shortcuts"]].map(([id, l]) => h("button", { class: "stab", role: "tab", "aria-selected": String(S.stab === id), onclick: () => { S.stab = id; renderMain(); } }, l))),
    ...content,
    needSave ? h("div", { class: "savebar" }, h("button", { class: "btn primary", "data-save": "1", disabled: S.dirty ? null : true, onclick: saveDraft }, "Save and test"), h("button", { class: "btn", "data-gofeed": "1", hidden: !(S.settings && S.settings.miniflux.token), onclick: () => go("feed") }, "Open Newsfeed"), h("span", { class: "note" }, S.dirty ? "You have unsaved changes." : "Nothing to save.")) : null)];
}

// ---------- moving a setup between machines ----------
const FX_NAMES = { keys: "Keys", settings: "Settings", order: "Folder order", ui: "Look and fonts" };
function fxLine(p) {
  const by = p.remote && p.remote.by ? ` by ${p.remote.by}` : "";
  if (p.state === "absent") return ["off", "Nothing in Firefox Sync yet."];
  if (p.state === "level") return ["green", `In step. Saved${by} ${since(p.remote.at)}.`];
  if (p.state === "remote-newer") return ["amber", `A newer copy${by} (${since(p.remote.at)}) is waiting. Fetch it below.`];
  return ["amber", "This machine has newer changes that Firefox Sync has not received. Send them below."];
}
async function fxAct(kind, force) {
  const r = await send({ type: kind === "pull" ? "profilePull" : "profilePush", force });
  if (!r) { toast("Firefox Sync is not available in this browser.", { kind: "error" }); return; }
  S.fx = r.summary;
  if (kind === "pull") {
    if (r.error) toast(r.error, { kind: "error" });
    else if (!r.applied.length) toast(Object.keys(r.found).length ? "This machine already has everything that Firefox Sync holds." : "Firefox Sync holds nothing for Pravaha yet. On your other machine, open Settings, Move setup and press Send. Firefox Sync can take a few minutes to deliver it.", { kind: "info" });
    else { const b = await send({ type: "boot" }); S.settings = b.settings; S.tree = b.tree; S.status = b.status; S.draft = null; adoptRemoteUi(b.settings); toast(`Took ${r.applied.map(a => PART_WORDS[a.part]).join(", ")} from Firefox Sync.`, { kind: "success" }); }
  } else toast(r.error ? r.error : r.sent && r.sent.length ? `Sent ${r.sent.map(x => PART_WORDS[x]).join(", ")} to Firefox Sync. It reaches your other machines after Firefox's next sync.` : "Nothing to send yet. Fill in Connections first.", { kind: r.error ? "warn" : "success" });
  renderMain(); if (kind === "pull") renderChrome();
}
function fxCard() {
  const fx = S.fx; const s = S.settings;
  const rows = fx ? fx.parts.map(p => { const [lamp, text] = fxLine(p); return h("div", { class: "fxrow" }, h("span", { class: "lamp " + lamp }), h("b", {}, FX_NAMES[p.part]), h("span", {}, text)); }) : [h("p", { class: "note" }, "Reading Firefox Sync.")];
  const tog = (label, key) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.sync[key] !== false, onchange: async (e) => { S.settings = await send({ type: "saveSettings", patch: { sync: { [key]: e.target.checked } } }); loadFx(); } }), label);
  return h("div", { class: "panel", "data-fx": "1" }, h("h2", {}, "Firefox Sync"),
    h("p", {}, "Your keys, settings, folder order and look travel to your other machines through Firefox Sync, which encrypts them end to end. A new machine takes them by itself the first time they arrive. Reading history does not use this route; it travels through the WebDAV storage."),
    h("div", { class: "fxrows" }, ...rows), fx && fx.error ? h("p", { class: "note bad" }, fx.error) : null,
    tog("Carry my keys (Miniflux, WebDAV, Raindrop)", "keys"), tog("Carry settings, folder order and look", "settings"),
    h("div", { class: "dfoot left" }, h("button", { class: "btn", "data-act": "fx-push", onclick: () => fxAct("push", true) }, "Send this machine's setup now"),
      h("button", { class: "btn", "data-act": "fx-pull", onclick: async () => { if (await askConfirm({ title: "Replace this machine's setup?", body: "This takes the copy held in Firefox Sync for the parts you carry, even where this machine has newer changes.", confirmLabel: "Fetch and replace" })) fxAct("pull", true); } }, "Fetch from Firefox Sync now")),
    h("p", { class: "note" }, "Firefox Sync must be signed in on both machines, with Add-ons ticked under Settings, Sync, Change. Firefox delivers new data in the background, usually within a few minutes. Machine names are never carried, so each machine keeps its own."));
}
const download = (name, text) => { try { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; document.body.append(a); a.click(); a.remove(); return true; } catch { return false; } };
function filePanel() {
  const ex = S.exp || (S.exp = { keys: false, pass: "", history: false }); const im = S.imp || (S.imp = { text: "", name: "", needPass: false, pass: "" });
  const exportNow = async () => {
    const r = await send({ type: "exportSettings", keys: ex.keys, passphrase: ex.pass, history: ex.history, ui: U });
    if (!r.ok) return toast(r.sentence, { kind: "error" });
    const saved = download(r.filename, r.text);
    toast(saved ? `Saved ${r.filename}${r.keys ? ". The keys in it are sealed with your passphrase" : ". It holds no keys"}${r.events ? `, with ${r.events.toLocaleString()} history events` : ""}.` : "The file could not be saved from this page.", { kind: saved ? "success" : "error" });
  };
  const importNow = async () => {
    if (!im.text) return toast("Choose a settings file first.", { kind: "warn" });
    const r = await send({ type: "importSettings", text: im.text, passphrase: im.pass });
    if (!r.ok) { if (r.code === "need-passphrase" || r.code === "bad-passphrase") { im.needPass = true; renderMain(); } return toast(r.sentence, { kind: "error" }); }
    S.settings = r.settings; S.draft = null; adoptRemoteUi(r.settings); Object.assign(im, { text: "", name: "", needPass: false, pass: "" });
    toast(`Imported ${r.applied.map(a => a === "history" ? `${r.events.toLocaleString()} history events` : PART_WORDS[a] || a).join(", ")}${r.from ? ` from ${r.from}` : ""}.`, { kind: "success", action: r.applied.includes("keys") ? { label: "Open Newsfeed", fn: () => go("feed") } : null });
    render(); loadFx();
  };
  return h("div", { class: "panel", "data-file": "1" }, h("h2", {}, "Settings file"),
    h("p", {}, "A single file with your settings, folder order and look, for moving a setup by hand or keeping a copy. Keys are never written in the clear."),
    h("h3", {}, "Export"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: ex.keys, "data-exp": "keys", onchange: (e) => { ex.keys = e.target.checked; renderMain(); } }), "Include my keys, sealed with a passphrase"),
    ex.keys ? h("label", { class: "field" }, "Passphrase (you will need it to import the keys)", h("input", { type: "password", autocomplete: "new-password", value: ex.pass, "data-exp": "pass", oninput: (e) => { ex.pass = e.target.value; } })) : null,
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: ex.history, "data-exp": "history", onchange: (e) => { ex.history = e.target.checked; } }), "Include my reading history and training (can be large)"),
    h("div", { class: "dfoot left" }, h("button", { class: "btn primary", "data-act": "export", onclick: exportNow }, "Export settings file")),
    h("h3", {}, "Import"),
    h("label", { class: "field" }, "Settings file", h("input", { type: "file", accept: ".json,application/json", "data-act": "import-file", onchange: async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; im.name = f.name; im.text = await f.text(); im.needPass = /"keys":\s*\{/.test(im.text); im.pass = ""; renderMain(); } })),
    im.text ? h("p", { class: "note" }, `${im.name} is ready to import.`) : null,
    im.needPass ? h("label", { class: "field" }, "Passphrase for the keys in this file", h("input", { type: "password", autocomplete: "off", value: im.pass, "data-imp": "pass", oninput: (e) => { im.pass = e.target.value; } })) : null,
    h("div", { class: "dfoot left" }, h("button", { class: "btn primary", "data-act": "import", disabled: im.text ? null : true, onclick: importNow }, "Import")),
    h("p", { class: "note" }, "Importing replaces the matching settings on this machine and sends them on through Firefox Sync. It never changes this machine's name."));
}
function moveMain() { return [fxCard(), filePanel()]; }

// ---------- add a feed ----------
// Miniflux's own server looks at the page and lists its feeds; this extension never contacts the site itself.
function openAddFeed(prefill = "") {
  if (!S.settings || !S.settings.miniflux.token) return toast("Connect Miniflux in Settings first.", { kind: "warn" });
  const st = { found: null, pick: null, cats: null, busy: false, folderFromScope: "" };
  const here = S.scope && S.scope.startsWith("cat:") ? S.scope.slice(4) : ""; st.folderFromScope = here;
  const input = h("input", { type: "text", placeholder: "https://example.com or the address of a feed", "aria-label": "Website or feed address", value: prefill, autocomplete: "off", spellcheck: "false", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } } });
  const findBtn = h("button", { class: "btn primary", "data-act": "find", onclick: () => find() }, icon("search", 15), "Find feeds");
  const results = h("div", { class: "results", "aria-live": "polite" }); const subscribeBtn = h("button", { class: "btn primary", "data-act": "subscribe", disabled: true, onclick: () => subscribe() }, icon("rss", 15), "Subscribe");
  let catSel = null, newCat = null;
  const close = () => closeDialog();
  const paint = (message) => {
    const kids = [];
    if (message) kids.push(h("div", { class: "res " + (message.bad ? "bad" : "idle") }, h("span", { class: "lamp " + (message.bad ? "red" : "off"), style: { marginTop: "4px" } }), h("span", {}, message.text)));
    if (st.found && st.found.length) {
      kids.push(...st.found.map((f, i) => h("label", { class: "feedopt", "data-dim": String(f.subscribed) }, h("input", { type: "radio", name: "feedpick", disabled: f.subscribed ? true : null, checked: st.pick === i, onchange: () => { st.pick = i; subscribeBtn.disabled = false; } }),
        h("div", {}, h("b", {}, f.title), h("span", {}, `${f.url}${f.type ? " · " + f.type : ""}${f.subscribed ? " · already subscribed" : ""}`)))));
      const opts = (st.cats || []).map(c => h("option", { value: String(c.id), selected: c.title === st.folderFromScope }, c.title));
      catSel = h("select", { "aria-label": "Folder", onchange: () => { newCat.hidden = catSel.value !== "new"; if (!newCat.hidden) newCat.focus(); } }, ...opts, h("option", { value: "new" }, "New folder…"));
      newCat = h("input", { type: "text", placeholder: "New folder name (use / for a sub-folder, like News/World)", "aria-label": "New folder name", hidden: opts.length ? true : null, autocomplete: "off" });
      if (!opts.length) catSel.value = "new";
      kids.push(h("label", { class: "field" }, "Add it to this folder", catSel), newCat);
    }
    results.replaceChildren(...kids);
  };
  async function find() {
    if (st.busy) return; const url = input.value.trim(); if (!url) { paint({ bad: true, text: "Enter a web address first." }); return; }
    st.busy = true; findBtn.disabled = true; subscribeBtn.disabled = true; st.pick = null; paint({ text: "Asking Miniflux to look at the page" });
    const r = await send({ type: "discover", url }); st.busy = false; findBtn.disabled = false;
    st.found = r.feeds || []; if (st.found.length) { st.cats = await send({ type: "categories" }); const open = st.found.map((f, i) => (f.subscribed ? -1 : i)).filter(i => i >= 0); if (open.length === 1) { st.pick = open[0]; subscribeBtn.disabled = false; } }
    paint({ bad: !r.ok, text: r.sentence });
  }
  async function subscribe() {
    const f = st.found && st.found[st.pick]; if (!f) return; subscribeBtn.disabled = true; findBtn.disabled = true;
    const isNew = catSel && catSel.value === "new"; const categoryId = isNew ? 0 : Number(catSel && catSel.value); const newCategory = isNew ? (newCat && newCat.value) || "" : "";
    paint({ text: "Subscribing. Miniflux is fetching the feed now" }); // read the choices first: painting rebuilds the folder list
    const r = await send({ type: "subscribe", feedUrl: f.url, categoryId, newCategory });
    if (r.ok) { close(); toast(r.sentence, { kind: "success", action: { label: "Open", fn: () => { S.tab = "feed"; lsSet("pravaha.tab", "feed"); S.scope = "feed:" + r.feedId; S.keep = new Set(); loadView(); } } }); S.tree = (await send({ type: "tree" })).tree; if (isFeedTab()) loadView(); }
    else { findBtn.disabled = false; subscribeBtn.disabled = false; paint({ bad: true, text: r.sentence }); }
  }
  S.dialog = "add"; S.dialogCancel = close;
  dialogHost().replaceChildren(h("div", { class: "overlay", onclick: close }, h("div", { class: "dialog narrow", role: "dialog", "aria-label": "Add a feed", onclick: (e) => e.stopPropagation() },
    h("h2", {}, "Add a feed"), h("p", {}, "Paste a website or a feed address. Miniflux looks for the feeds on that page and you pick which to follow."),
    h("div", { class: "urlrow" }, input, findBtn), results, h("div", { class: "dfoot" }, h("button", { class: "btn", "data-act": "cancel", onclick: close }, "Close"), subscribeBtn))));
  input.focus(); if (prefill) find();
}
function handleHash() {
  const m = /^#subscribe=(.+)$/.exec(location.hash || ""); if (!m) return; let u = ""; try { u = decodeURIComponent(m[1]); } catch { return; }
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
  if (/^https?:\/\//i.test(u)) openAddFeed(u);
}
window.addEventListener("hashchange", handleHash);

// ---------- keyboard ----------
function selectOffset(d, openIt) {
  const els = rowEls(); if (!els.length) return; let i = els.findIndex(e => Number(e.dataset.id) === S.selId); i = i < 0 ? (d > 0 ? 0 : els.length - 1) : Math.min(els.length - 1, Math.max(0, i + d));
  const id = Number(els[i].dataset.id); selectRow(id); els[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (openIt && S.rows.get(id)) openCardFor(S.rows.get(id));
}
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; const t = e.target; const typing = t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
  if (S.dialog) { if (e.key === "Escape" && S.dialogCancel) { S.dialogCancel(); e.preventDefault(); } return; }
  if (e.key === "Escape") { if (t && t.matches && t.matches(".search input") && t.value) { clearSearch(); return; } if (S.help) { S.help = false; renderOverlay(); } else if (S.pop) { S.pop = null; renderPop(); } else if (typing) t.blur(); else if (S.openCard && S.rows.get(S.openCard)) closeCard(S.rows.get(S.openCard)); return; }
  if (typing) return;
  if (e.key === "?") { S.help = !S.help; renderOverlay(); e.preventDefault(); return; }
  if (e.key === "B") { toggleBionic(); e.preventDefault(); return; }
  if (e.key === "a" && S.settings && S.settings.miniflux.token) { openAddFeed(); e.preventDefault(); return; }
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
      case "A": { const g = currentGroup(); if (g) markSectionRead(g); else toast("Nothing unread to mark in a section.", { kind: "info" }); return true; }
      case "M": markAllRead(); return true;
      case "u": S.mode = S.mode === "unread" ? "all" : "unread"; S.keep = new Set(); loadView(); return true;
      case "r": syncNow(); return true; default: return false;
    }
  })();
  if (handled) e.preventDefault();
});

boot().catch(err => { $app.replaceChildren(h("div", { class: "empty" }, h("div", { class: "t" }, "Pravaha could not start"), h("div", {}, String(err && err.message || err)), h("pre", { class: "errstack" }, String(err && err.stack || "").split("\n").slice(0, 6).join("\n")))); });
