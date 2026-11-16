// Pravaha reader. Text is inserted as text nodes; article HTML goes through renderSafe, never innerHTML.
import { h, icon, pct, ago, longAgo } from "./dom.js";
import { gradeColor, disp, PALETTE_NAMES, THEME_PALETTE } from "../src/grade.js";
import { renderSafe } from "../src/safehtml.js";
import { anchorTree } from "../src/anchor.js";
import { loadPrefs, normalisePrefs, savePrefs, applyPrefs, clamp, READ_FONTS, UI_FONTS, FONT_INFO, CONFIRM_MODES, THEME_IDS } from "./prefs.js";

const $app = document.getElementById("app");
const MUTATING = new Set(["markRead", "markUnread", "markScope", "save", "dismiss", "undismissAll", "syncNow", "subscribe", "searchServer", "card", "open", "feedUpdate", "feedDelete", "folderRename", "refreshScope", "rate", "train"]);
const send = async (m) => {
  if (MUTATING.has(m.type)) setTimeout(kickSync, 60);
  try { return await browser.runtime.sendMessage(m); } catch (e) { toast("The background page did not answer. Reload the extension if this keeps happening.", { kind: "error" }); throw e; }
};
// Optional timing for development: set localStorage "pravaha.perf" to 1, then read window.__pvPerf. Off by default.
const PERF = (() => { try { return localStorage.getItem("pravaha.perf") === "1"; } catch { return false; } })();
const tm = PERF ? (name, fn) => { const t0 = performance.now(); const r = fn(); (window.__pvPerf ||= {})[name] = Math.round((performance.now() - t0) * 10) / 10; return r; } : (name, fn) => fn();
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export const S = {
  tab: lsGet("pravaha.tab", "feed"), scope: "all", mode: "unread", ranked: false, q: "",
  settings: null, tree: [], status: null, rules: [], data: null, icons: {}, iconCount: 0, unread: 0,
  rows: new Map(), rowGroup: new Map(), openCard: null, selId: null, keep: new Set(), content: {}, tags: {}, trainer: {}, limits: {},
  collapsed: new Set(lsGet("pravaha.collapsed", [])), auto: new Set(), treeCollapsed: new Set(lsGet("pravaha.treeCollapsed", [])),
  newIds: new Set(), pop: null, help: false, toast: "", busy: false, stats: null, searchIn: "all", moved: null, dialog: null, syncFlash: 0,
  stab: "connections", ytab: "overview", feedsInfo: null, fq: "", fprob: false, fpage: 1, serverLines: null, serverBusy: false, draft: null, tests: {}, dirty: false
};
let U = loadPrefs();
const prefersDark = () => !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
let uiPushT = null;
let lastFxLook = 0;
document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible" || Date.now() - lastFxLook < 20000) return; lastFxLook = Date.now(); send({ type: "profilePull", force: false }).catch(() => {}); });
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
// Asking for a row whose section has not been built yet builds that section first, so nothing that selects or opens an article can miss it.
const rowElById = (id, build = true) => {
  const q = () => $app.querySelector(`.row[data-id="${id}"]`); const el = q(); if (el || !build) return el;
  const g = S.rowGroup.get(id); if (g && g.pending) { fillNow(g); return q(); } return null;
};
const groupOf = (id) => S.rowGroup.get(id) || null;
const isCollapsed = (key) => S.collapsed.has(key) || S.auto.has(key);

// ---------- data ----------
const searchQuery = () => { const q = S.q.trim(); return /(^|\s)in:\w+/i.test(q) || S.searchIn === "all" ? q : `${q} in:${S.searchIn}`; };
async function loadSearch() {
  const [r, t] = await Promise.all([send({ type: "search", q: searchQuery() }), send({ type: "tree" })]);
  S.tree = t.tree; S.status = t.status; S.unread = t.unreadTotal;
  S.data = { search: true, terms: r.terms || [], indexSize: r.indexSize, empty: r.empty, groups: r.rows.length ? [{ key: "search", search: true, title: "Search results", unread: r.rows.filter(x => !x.read).length, rows: r.rows }] : [], total: r.rows.length, unreadTotal: S.unread, dismissedCount: 0, iconCount: S.iconCount };
  S.rows = new Map(); S.rowGroup = new Map(); for (const row of r.rows) { S.rows.set(row.id, row); S.rowGroup.set(row.id, S.data.groups[0]); }
  if (S.openCard && !S.rows.has(S.openCard)) stopDwell(), S.openCard = null;
  render();
}
async function loadView() {
  if (S.q.trim()) return loadSearch();
  const tv = PERF ? performance.now() : 0; const r = await send({ type: "view", params: { scope: S.tab === "saved" ? "saved" : S.scope, mode: S.mode, ranked: S.ranked, q: S.q, keep: [...S.keep] } });
  if (PERF) (window.__pvPerf ||= {}).viewRoundTrip = Math.round(performance.now() - tv);
  S.data = r.view; S.tree = r.tree; S.status = r.status; S.unread = r.view.unreadTotal; S.newIds = new Set();
  S.rows = new Map(); S.rowGroup = new Map(); for (const g of S.data.groups) for (const row of g.rows) { S.rows.set(row.id, row); S.rowGroup.set(row.id, g); }
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
  if (!isFeedTab() || !S.data) { refreshChrome(); if (S.tab === "sync") { S.status = await send({ type: "status" }); S.stats = await send({ type: "stats" }); renderMain(); } else if (S.tab === "settings" && S.stab === "feeds") loadFeedsInfo(); return; }
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
  if (!im.fresh) return; // the routine trickle of changes between two active machines is not announced
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
// act runs inside the click itself, because Firefox only allows some requests (like a permission prompt) straight from a click.
function askConfirm({ title, body, confirmLabel = "OK", cancelLabel = "Cancel", act = null }) {
  return new Promise((resolve) => {
    S.dialog = "confirm"; const done = (v) => { closeDialog(); resolve(v); }; S.dialogCancel = () => done(false);
    const ok = h("button", { class: "btn primary", "data-act": "confirm", onclick: () => done(act ? act() : true) }, confirmLabel);
    dialogHost().replaceChildren(h("div", { class: "overlay", onclick: () => done(false) }, h("div", { class: "dialog narrow", role: "alertdialog", "aria-label": title, onclick: (e) => e.stopPropagation() },
      h("h2", {}, title), ...[].concat(body).map(t => h("p", {}, t)), h("div", { class: "dfoot" }, h("button", { class: "btn", "data-act": "cancel", onclick: () => done(false) }, cancelLabel), ok))));
    ok.focus();
  });
}
// One small form dialog for the feed and folder actions: a text box, a folder picker, or a typed confirmation. It resolves with the answer, or null if cancelled.
// kind "text" asks for a name; "folder" asks for a folder (existing, or New folder…); "typed" asks for the exact name before a delete.
function askForm({ title, body = [], kind = "text", value = "", label = "", options = [], expect = "", confirmLabel = "Save", danger = false, alt = null }) {
  return new Promise((resolve) => {
    S.dialog = "form"; const done = (v) => { closeDialog(); resolve(v); }; S.dialogCancel = () => done(null);
    const isSel = kind === "folder"; const NEW = "__new__";
    const input = isSel
      ? h("select", { "aria-label": label || "Folder", "data-field": "folder" }, ...options.map(o => h("option", { value: o, selected: o === value }, o)), h("option", { value: NEW }, "New folder…"))
      : h("input", { type: "text", value, "aria-label": label || title, "data-field": kind, autocomplete: "off", spellcheck: "false", placeholder: kind === "typed" ? expect : "" });
    const fresh = h("input", { type: "text", "aria-label": "New folder name", "data-field": "newfolder", placeholder: "Folder or Parent/Child", hidden: true, autocomplete: "off" });
    const ok = h("button", { class: "btn " + (danger ? "danger" : "primary"), "data-act": "confirm", disabled: kind === "typed" ? true : null }, confirmLabel);
    const val = () => isSel ? (input.value === NEW ? fresh.value.trim() : input.value) : input.value;
    const gate = () => { ok.disabled = kind === "typed" ? input.value.trim() !== expect.trim() : !val().trim(); };
    const submit = () => { if (!ok.disabled) done(val()); };
    input.addEventListener("input", gate); fresh.addEventListener("input", gate);
    if (isSel) input.addEventListener("change", () => { fresh.hidden = input.value !== NEW; if (!fresh.hidden) fresh.focus(); gate(); });
    const keys = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    input.addEventListener("keydown", keys); fresh.addEventListener("keydown", keys); ok.addEventListener("click", submit);
    dialogHost().replaceChildren(h("div", { class: "overlay", onclick: () => done(null) }, h("div", { class: "dialog narrow", role: "dialog", "aria-label": title, onclick: (e) => e.stopPropagation() },
      h("h2", {}, title), ...[].concat(body).map(t => h("p", {}, t)), h("label", { class: "field" }, h("span", {}, label), input), isSel ? fresh : null,
      h("div", { class: "dfoot" }, alt ? h("button", { class: "btn", "data-act": "alt", onclick: () => done({ alt: true }) }, alt) : null, h("button", { class: "btn", "data-act": "cancel", onclick: () => done(null) }, "Cancel"), ok))));
    gate(); input.focus(); if (!isSel && input.select) input.select();
  });
}
// Feed detection needs Firefox's all-websites permission, so Pravaha explains it first in its own words. Firefox then shows its own prompt.
const ALL_SITES = ["https://*/*", "http://*/*"];
async function loadDetect() { try { S.detect = await send({ type: "feedDetectState" }); } catch { S.detect = { on: false, unavailable: true }; } if (S.tab === "settings" && S.stab === "machine") renderMain(); }
async function toggleDetect() {
  const st = S.detect || {}; if (st.unavailable || S.detectBusy) return; S.detectBusy = true; S.detectMsg = ""; renderMain();
  try {
    if (st.on) { S.detect = await send({ type: "feedDetectOff" }); S.detectMsg = "Feed detection is off. Right-click Subscribe with Pravaha still works."; }
    else {
      const ask = await askConfirm({ title: "Detect feeds on pages?", act: () => browser.permissions.request({ origins: ALL_SITES }).then(ok => ({ ok }), (err) => ({ ok: false, err })), confirmLabel: "Continue to Firefox’s question", cancelLabel: "Not now", body: [
        "Pravaha can colour its toolbar icon on pages that offer a feed, so you can subscribe in one click. To do that, Firefox has to let Pravaha run a small script on web pages. Firefox words this as “Access your data for all websites”, and that wording is Firefox’s, not ours.",
        "The script reads one thing: the feed links in the page’s head. It hands those addresses to Pravaha inside your browser. It does not read the page text, forms or cookies, and nothing is sent anywhere.",
        "You can turn this off here at any time. If you say no, nothing changes: right-click, Subscribe with Pravaha, keeps working on any page or link."] });
      if (!ask) S.detectMsg = "Feed detection stays off.";
      else {
        const ok = ask.ok;
        if (!ok) S.detectMsg = "Firefox did not grant it, so detection stays off. Right-click Subscribe with Pravaha still works.";
        else { S.detect = await send({ type: "feedDetectOn" }); S.detectMsg = S.detect.on ? "Feed detection is on. Pages you open from now on are checked; ones already open are not." : (S.detect.sentence || "Feed detection could not be turned on."); }
      }
    }
  } catch (e) { S.detectMsg = "Something went wrong, and feed detection was left as it was. Firefox said: " + String((e && e.message) || e).slice(0, 160); await loadDetect(); }
  S.detectBusy = false; renderMain();
}
function detectPanel() {
  const st = S.detect; if (!st) loadDetect(); const on = !!(st && st.on);
  return h("div", { class: "panel", "data-panel": "detect" }, h("h2", {}, "Feeds on web pages"),
    h("div", { class: "switchrow" }, h("button", { class: "switch", role: "switch", "data-act": "detect-feeds", "aria-checked": String(on), "aria-label": "Detect feeds on pages", disabled: !st || st.unavailable || S.detectBusy ? true : null, onclick: toggleDetect }, h("i", {})),
      h("div", {}, h("b", {}, "Detect feeds on pages"), h("span", { class: "sub" }, on ? "On. The toolbar icon turns amber on pages that offer a feed." : "Off. The toolbar icon stays as it is."))),
    h("p", { class: "note", "aria-live": "polite", "data-note": "detect" }, st && st.unavailable ? "Feed detection is not available in this browser." : S.detectMsg || "Turning it on asks Firefox for permission to run on all websites. Right-click Subscribe with Pravaha works without it."));
}
const confirmIf = (kind, body) => { const m = U.confirmRead; return m === "never" || (m === "bulk" && kind === "single") ? Promise.resolve(true) : askConfirm({ title: "Mark as read?", body, confirmLabel: "Mark read" }); };

// ---------- actions ----------
function patchRow(r) {
  const gr = groupOf(r.id); const el = rowElById(r.id, false); if (!el) { if (gr) updateGroupHead(gr); return; }
  el.dataset.read = String(r.read); el.dataset.saved = String(r.saved); el.dataset.pending = String(!!r.pending);
  const pd = el.querySelector(".pdot"); if (r.pending && !pd) { const nd = el.querySelector(".newdot"); if (nd) nd.after(h("span", { class: "pdot", title: "Sending to Miniflux" })); } else if (!r.pending && pd) pd.remove();
  const g = gradeOf(r.score); el.style.setProperty("--grade", g.bg); el.style.setProperty("--gfg", g.fg);
  const sc = el.querySelector(".score"); if (sc) sc.textContent = String(pct(g.d)); const bar = el.querySelector(".gbar i"); if (bar) bar.style.width = pct(g.d) + "%";
  const sv = el.querySelector("[data-act='save']"); if (sv) { sv.replaceChildren(icon("star", 17, r.saved)); sv.setAttribute("aria-pressed", String(r.saved)); sv.title = r.saved ? "Remove from saved (s)" : "Save (s)"; }
  const rd = el.querySelector("[data-act='read']"); if (rd) rd.textContent = r.read ? "Mark unread" : "Mark read";
  const cs = el.querySelector("[data-act='cardsave'] span"); if (cs) cs.textContent = r.saved ? "Saved" : "Save";
  if (gr) updateGroupHead(gr);
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
  S.rows.delete(r.id); S.rowGroup.delete(r.id); if (S.data) S.data.dismissedCount = (S.data.dismissedCount || 0) + 1; const oldSub = $app.querySelector(".sub"); if (oldSub) oldSub.replaceWith(feedSub());
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
// ---------- training: a thumb on the article, clickable tags and words ----------
const nextVal = (v) => { const s = Math.sign(v || 0); return s === 0 ? 1 : s > 0 ? -1 : 0; };
const dshort = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const safeHref = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
function applyScore(r, res) { if (res && Number.isFinite(res.score)) { r.score = res.score; r.why = res.why; r.breakdown = res.breakdown; patchRow(r); } }
async function rateRow(r, v) {
  const next = r.rating === v ? 0 : v;
  const res = await send({ type: "rate", id: r.id, value: next });
  if (!res || !res.ok) return toast("That article is no longer stored here, so it cannot be trained.", { kind: "warn" });
  r.rating = next; applyScore(r, res); S.rules = await send({ type: "rules" });
  const el = rowElById(r.id, false); if (el) { el.dataset.rating = String(next); for (const b of el.querySelectorAll(".rate")) { const on = Number(b.dataset.v) === next; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); const ic = b.querySelector("svg"); if (ic) ic.replaceWith(icon(Number(b.dataset.v) > 0 ? "thumbup" : "thumbdown", b.classList.contains("btn") ? 15 : 17, on)); } }
  if (S.openCard === r.id) loadTrainer(r);
  const names = (res.labels || []).slice(0, 4).join(", ");
  toast(next > 0 ? `Noted. More like this${names ? ": " + names : ""}.` : next < 0 ? `Noted. Less like this${names ? ": " + names : ""}.` : "Thumb taken back.", { kind: "success", action: next ? { label: "Undo", fn: () => rateRow(r, 0) } : undefined });
}
async function loadTrainer(r) { const t = await send({ type: "trainer", id: r.id }); if (!t) return; S.trainer[r.id] = t; if (S.openCard === r.id) fillStrip(r); }
async function trainChip(r, type, c, label, v) {
  const t = S.trainer[r.id]; if (!t) return; c.value = v;
  fillStrip(r, v === 0 ? `Training for “${label}” cleared.` : v > 0 ? `More of “${label}” from now on. Click again for less, a third time to clear.` : `Less of “${label}” from now on. Click again to clear.`);
  await send({ type: "train", kind: type, key: c.key, value: v }); S.rules = await send({ type: "rules" }); applyScore(r, await send({ type: "score", id: r.id }));
}
function chip(r, type, c, label) {
  const v = c.value || 0; const state = v > 0 ? "more" : v < 0 ? "less" : "neutral"; const nv = nextVal(v);
  const act = nv > 0 ? "see more of it" : nv < 0 ? "see less of it" : "clear it";
  return h("button", { class: "tchip", "data-v": String(Math.sign(v)), "data-key": c.key, "aria-pressed": String(v !== 0), title: (c.source === "raindrop" ? "A tag from your own Raindrop save of this page. " : "") + `Click to ${act}.`, "aria-label": `${label}: ${state}. Click to ${act}.`, onclick: () => trainChip(r, type, c, label, nv) },
    c.source === "raindrop" ? icon("bookmark", 12) : null, h("span", {}, label), v ? icon(v > 0 ? "thumbup" : "thumbdown", 13, true) : null);
}
function rdLine(b, lead) {
  const href = safeHref(b.link);
  return h("div", { class: "rdline" }, icon("bookmark", 14), h("span", {}, lead, href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, b.title || b.link) : (b.title || "an untitled save"), b.at ? ` (${dshort(b.at)})` : "", b.tags && b.tags.length ? " · " + b.tags.map(x => "#" + x).join(" ") : "", b.note ? h("em", {}, ` “${b.note}”`) : null));
}
function stripKids(r, say) {
  const t = S.trainer[r.id]; if (!t) return [h("span", { class: "note" }, "Looking for tags…")];
  const kids = [h("div", { class: "trow" }, h("strong", {}, "Tags"), ...(t.tags.length ? t.tags.map(c => chip(r, "tag", c, c.tag)) : [h("span", { class: "note" }, t.raindrop.configured ? "No tag from your Raindrop saves is close enough to this article yet." : "Add a Raindrop token in Settings to get tags from your own saves.")]))];
  if (t.words.length) kids.push(h("div", { class: "trow" }, h("strong", {}, "Words"), ...t.words.map(c => chip(r, "keyword", c, c.word))));
  kids.push(h("p", { class: "note tnote", role: "status", "aria-live": "polite" }, say || "Click a tag or word to see more of it, again for less, a third time to clear. The thumbs above train on the top three tags and words together."));
  const rd = t.raindrop || {};
  if (rd.exact) kids.push(rdLine(rd.exact, "You saved this page in Raindrop: "));
  for (const b of rd.related || []) kids.push(rdLine(b, "Close to something you saved: "));
  return kids;
}
function fillStrip(r, say) { const host = rowElById(r.id, false)?.querySelector(".tstrip"); if (host) host.replaceChildren(...stripKids(r, say)); }
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
  el.dataset.card = "false"; fillCard(r); loadTrainer(r); requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.card = "true"; setTimeout(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60); }));
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
  const rule = (type, key) => (S.rules.find(x => x.type === type && x.key === String(key).toLowerCase()) || {}).value || 0;
  const tr = (name, type, key) => h("span", { class: "trainrow" }, h("span", {}, name), ...[["More", 1], ["Less", -1]].map(([l, v]) => h("button", { class: "kw", "data-v": String(Math.sign(rule(type, key)) === v ? v : 0), onclick: () => train(type, key, rule(type, key) === v ? 0 : v) }, l)));
  const bars = [["Tag match", bk.tagOverlap], ["Sites you read", bk.bookmarkEcho], ["Feed standing", bk.feedAuthority], ["Freshness", bk.freshness], ["Covered by several feeds", bk.hot || 0]].map(([n, v]) => h("div", { style: { "--grade": gradeOf(v).bg } }, h("span", {}, `${n}: ${pct(v)}`), h("div", { class: "gbar" }, h("i", { style: { width: pct(v) + "%" } }))));
  const btn = (act, ic, label, key, fn, on) => h("button", { class: "btn small" + (on ? " on" : ""), "data-act": act, onclick: fn }, icon(ic, 15, act === "cardsave" && r.saved), h("span", {}, label), key ? h("kbd", {}, key) : null);
  host.replaceChildren(h("div", { class: "card" },
    h("h2", { class: "ctitle" }, r.title),
    h("div", { class: "cmeta" }, h("span", { class: "fav-wrap", style: { display: "inline-flex", alignItems: "center", gap: "6px" } }, iconFor(r.feedId, r.feedTitle), r.feedTitle), r.author ? h("span", {}, r.author) : null, h("span", {}, longAgo(r.publishedAt)),
      r.readingTime ? h("span", {}, `${r.readingTime} min read`) : null, c.full ? h("span", { class: "chip ok" }, icon("coffee", 12), "Full article") : null),
    h("div", { class: "cacts" },
      h("button", { class: "btn small bionic" + (U.anchor ? " on" : ""), "data-act": "bionic", "aria-pressed": String(U.anchor), title: "Bionic reading: bold the start of each word (Shift+B)", onclick: toggleBionic }, h("b", {}, "B"), h("span", {}, "Bionic"), h("kbd", {}, "Shift+B")),
      btn("bg", "ext", "Open in background", "b", () => backgroundOpen(r)),
      btn("full", "coffee", c.full ? "Reload full article" : "Fetch full article", "w", () => fetchFull(r), c.loading),
      ...[[1, "thumbup", "More like this", "+"], [-1, "thumbdown", "Less like this", "-"]].map(([v, ic, l, k]) => h("button", { class: "btn small rate" + (r.rating === v ? " on" : ""), "data-act": v > 0 ? "up" : "down", "data-v": String(v), "aria-pressed": String(r.rating === v), onclick: () => rateRow(r, v) }, icon(ic, 15, r.rating === v), h("span", {}, l), h("kbd", {}, k))),
      btn("cardsave", "star", r.saved ? "Saved" : "Save", "s", () => saveRow(r), r.saved),
      h("button", { class: "btn small", "data-act": "read", onclick: () => toggleRead(r) }, r.read ? "Mark unread" : "Mark read"),
      btn("dismiss", "x", "Dismiss", "x", () => dismissRow(r)), btn("close", "up2", "Close", "Esc", () => closeCard(r))),
    h("div", { class: "tstrip" }, ...stripKids(r)),
    c.notice ? h("div", { class: "notice" }, c.notice) : null, c.error ? h("div", { class: "notice" }, c.error + " Showing the summary instead.") : null,
    need ? h("div", { class: "notice" }, "This feed only sends a short excerpt. Press w, or the coffee button, to fetch the whole article.") : null,
    body,
    h("details", { class: "why" },
      h("summary", {}, "Why it ranks here"), h("p", { class: "note" }, `Ranks here because it is ${r.why}.`), h("div", { class: "bars" }, bars),
      h("div", { class: "trainrow" }, h("strong", {}, "Train the whole source:"), tr(r.feedTitle, "feed", r.feedId), r.author ? tr(r.author, "author", r.author) : null))));
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
    r.flag ? h("span", { class: "chip warn" }, "Serendipity") : null,
    r.breakdown && r.breakdown.hotOthers > 0 ? h("span", { class: "chip hot", title: `The same story is in ${r.breakdown.hotOthers} other feed${r.breakdown.hotOthers > 1 ? "s" : ""} you follow.` }, icon("flame", 12), `${r.breakdown.hotOthers + 1} feeds`) : null, r.words && r.words < 150 && !r.media ? h("span", { class: "chip", title: "This feed sends only an excerpt. Press w to fetch the full article." }, icon("coffee", 12), "Excerpt") : null,
    ...(r.tags || []).slice(0, 3).map(t => h("span", { class: "chip tag" }, "#" + t))].filter(Boolean);
  const act = (name, ic, title, fn, cls = "") => h("button", { class: "ibtn " + cls, "data-act": name, title, "aria-label": title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 17, name === "save" && r.saved));
  const rate = (v) => h("button", { class: "ibtn rate" + (r.rating === v ? " on" : ""), "data-act": v > 0 ? "up" : "down", "data-v": String(v), "aria-pressed": String(r.rating === v), title: v > 0 ? "More like this (+)" : "Less like this (-)", "aria-label": v > 0 ? "More like this" : "Less like this", onclick: (e) => { e.stopPropagation(); rateRow(r, v); } }, icon(v > 0 ? "thumbup" : "thumbdown", 17, r.rating === v));
  return h("article", { class: "row", data: { id: r.id, read: String(r.read), saved: String(r.saved), sel: String(S.selId === r.id), card: "false", pending: String(!!r.pending), rating: String(r.rating || 0) }, style: { "--grade": g.bg, "--gfg": g.fg }, onclick: () => selectRow(r.id) },
    h("span", { class: "strip", "aria-hidden": "true" }),
    h("div", { class: "rmain" },
      h("div", { class: "rmeta" }, h("span", { class: "newdot", title: "Unread" }), r.pending ? h("span", { class: "pdot", title: "Sending to Miniflux" }) : null, metaLine),
      h("button", { class: "rtitle", onclick: (e) => { e.stopPropagation(); openCardFor(r); } }, hl(r.title)),
      r.summary ? h("div", { class: "rsnip" }, hl(r.summary)) : null, chips.length ? h("div", { class: "chips" }, chips) : null),
    h("div", { class: "rside" }, U.thumbs && r.thumb ? h("img", { class: "thumb", src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      h("div", { class: "grade", title: `Relevance ${pct(g.d)} of 100 (raw ${pct(r.score)}; ${r.why})` }, h("span", { class: "score" }, String(pct(g.d))), h("div", { class: "gbar" }, h("i", { style: { width: pct(g.d) + "%" } })))),
    h("div", { class: "acts" }, rate(1), rate(-1), act("save", "star", r.saved ? "Remove from saved (s)" : "Save (s)", () => saveRow(r), "save"), act("bg", "ext", "Open in a background tab (b)", () => backgroundOpen(r)),
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
  if (was && g.pending) fillNow(g);
  if (!was && S.openCard && g.rows.some(r => r.id === S.openCard)) closeCard(S.rows.get(S.openCard), true);
}
function setAllGroups(collapse) {
  for (const g of S.data.groups) { S.auto.delete(g.key); collapse ? S.collapsed.add(g.key) : S.collapsed.delete(g.key); if (g.el) { g.el.dataset.collapsed = String(collapse); g.el.querySelector(".gtoggle")?.setAttribute("aria-expanded", String(!collapse)); } }
  lsSet("pravaha.collapsed", [...S.collapsed]); if (collapse && S.openCard) closeCard(S.rows.get(S.openCard), true); if (!collapse) kickFill();
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
// A long list is built in slices: the first screens at once, the rest a few sections per frame, nearest the viewport first.
// A section that is folded, or not reached yet, shows only its header and keeps roughly its height until its rows are built.
const FIRST_ROWS = 60, SLICE_MS = 9, LAZY_FROM = 150; let fillToken = 0;
const estRowH = () => (U.density === "compact" ? 52 : 84);
function planFill(groups) {
  const total = groups.reduce((n, g) => n + g.rows.length, 0); let built = 0;
  for (const g of groups) {
    const now = total <= LAZY_FROM || built < FIRST_ROWS || g.rows.some(r => r.id === S.openCard || r.id === S.selId);
    g.pending = !now; if (now) built += Math.min(g.rows.length, 120);
  }
}
function fillNow(g) {
  if (!g.pending || !g.el) return; const inner = g.el.querySelector(".gin"); g.pending = false; if (!inner) return;
  inner.style.minHeight = ""; fillGroupRows(g, inner);
  if (io) for (const el of inner.querySelectorAll(".row[data-read='false']")) io.observe(el);
}
function kickFill() {
  const token = ++fillToken; if (!S.data || S.data.search || !S.data.groups.some(g => g.pending)) return;
  const wanted = (g) => g.pending && g.el && g.el.isConnected && !isCollapsed(g.key);
  const step = () => {
    if (token !== fillToken || !S.data) return; const t0 = performance.now(); const vh = window.innerHeight || 800;
    for (const g of S.data.groups) {   // the sections on or near the screen come first
      if (!wanted(g)) continue; const r = g.el.getBoundingClientRect(); if (r.bottom > -vh && r.top < vh * 2) fillNow(g);
      if (performance.now() - t0 > SLICE_MS) break;
    }
    if (performance.now() - t0 <= SLICE_MS) for (const g of S.data.groups) { if (!wanted(g)) continue; fillNow(g); if (performance.now() - t0 > SLICE_MS) break; }
    if (S.data.groups.some(wanted)) requestAnimationFrame(step); else if (!S.data.groups.some(g => g.pending)) observeRows();
  };
  requestAnimationFrame(step);
}
function groupEl(g) {
  const inner = h("div", { class: "gin" }); if (g.pending) inner.style.minHeight = Math.min(g.rows.length, 120) * estRowH() + "px"; else fillGroupRows(g, inner);
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
  if (d && !d.search) planFill(d.groups);
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
const THEMES = THEME_IDS; const THEME_NAMES = { light: "Light", khadi: "Khadi (cotton and sindoor)", dark: "Dark", jamun: "Jamun (plum and saffron)", lacquer: "Lacquer (oxblood and jade)", oled: "OLED black", auto: "Follow the system" };
// Choosing one of the 0.8.0 themes also takes its matching relevance colours, unless you then pick others.
const OWN_PALETTES = new Set(Object.values(THEME_PALETTE).filter(p => p !== "ember"));
const themePatch = (t) => (THEME_PALETTE[t] && THEME_PALETTE[t] !== "ember" ? { theme: t, palette: THEME_PALETTE[t] } : OWN_PALETTES.has(U.palette) ? { theme: t, palette: "ember" } : { theme: t }); // leaving Khadi, Jamun or Lacquer drops their colours too
function go(tab) {
  S.lastSheet = null;
  stopDwell(); dw.id = null; S.openCard = null; S.tab = tab; lsSet("pravaha.tab", tab); S.keep = new Set(); S.pop = null;
  if (tab === "feed" || tab === "saved") loadView();
  else if (tab === "stats") Promise.all([send({ type: "stats" }), send({ type: "rules" })]).then(([st, ru]) => { S.stats = st; S.rules = ru; render(); });
  else if (tab === "sync") Promise.all([send({ type: "status" }), send({ type: "stats" })]).then(([st, sa]) => { S.status = st; S.stats = sa; render(); loadFx(); });
  else { S.draft = null; render(); }
}
function topBar() {
  const themeIcon = { light: icon("sun"), khadi: icon("sun", 18, true), dark: icon("moon"), jamun: icon("palette"), lacquer: icon("palette"), oled: icon("moon", 18, true), auto: icon("clock") }[U.theme] || icon("moon");
  return h("header", { class: "top" }, progressEl(),
    h("button", { class: "ibtn", title: "Show or hide the folder list", "aria-label": "Toggle folders", onclick: () => { setPref({ side: !U.side }); renderChrome(); } }, icon("menu", 20)),
    h("div", { class: "brand" }, h("img", { src: "../icons/icon-32.png", alt: "" }), "Pravaha"),
    h("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" }, TABS.map(([id, label, ic]) => h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === id), onclick: () => go(id) }, icon(ic, 16), h("span", { class: "lbl" }, label), id === "feed" && S.unread ? h("span", { class: "count" }, S.unread > 999 ? "999+" : S.unread) : null))),
    h("div", { class: "grow" }),
    isFeedTab() ? h("label", { class: "search" }, icon("search", 15), h("input", { type: "search", placeholder: "Search everything  ( / )", "aria-label": "Search articles", value: S.q, oninput: debounce((e) => { S.q = e.target.value; loadView(); }, 260) })) : null,
    h("button", { class: "ibtn bionic", "aria-pressed": String(U.anchor), title: "Bionic reading: bold the start of each word (Shift+B)", "aria-label": "Bionic reading", onclick: toggleBionic }, h("b", {}, "B"), h("span", {}, "r")),
    h("button", { class: "ibtn aa", title: "Reading type", "aria-label": "Reading type", "aria-expanded": String(S.pop === "aa"), onclick: (e) => { e.stopPropagation(); S.pop = S.pop === "aa" ? null : "aa"; renderPop(); } }, "Aa"),
    h("button", { class: "ibtn", title: `Theme: ${THEME_NAMES[U.theme]}. Click to change.`, "aria-label": "Change theme", onclick: () => { setPref(themePatch(THEMES[(THEMES.indexOf(U.theme) + 1) % THEMES.length])); renderChrome(); if (isFeedTab()) renderMain(); toast("Theme: " + THEME_NAMES[U.theme]); } }, themeIcon),
    h("button", { class: "ibtn", title: "Keyboard shortcuts (?)", "aria-label": "Keyboard shortcuts", onclick: () => { S.help = true; renderOverlay(); } }, icon("help")),
    pillEl());
}
const isTopFolder = (n) => !!n && n.type === "folder" && !n.parent;
function sideBar() {
  const byId = new Map(S.tree.map(n => [n.id, n]));
  const hidden = (n) => { for (let p = n.parent && byId.get(n.parent); p; p = p.parent && byId.get(p.parent)) if (S.treeCollapsed.has(p.id)) return true; return false; };
  const parents = new Set(); for (const x of S.tree) if (x.parent) parents.add(x.parent); const hasKids = (n) => parents.has(n.id);
  const open = (id) => { S.scope = id; if (S.tab !== "feed") { S.tab = "feed"; lsSet("pravaha.tab", "feed"); } S.keep = new Set(); loadView(); };
  const rows = S.tree.filter(n => !hidden(n)).map(n => {
    const chev = n.type === "folder" && hasKids(n) ? h("button", { class: "chev", "aria-label": (S.treeCollapsed.has(n.id) ? "Expand " : "Collapse ") + n.label, "aria-expanded": String(!S.treeCollapsed.has(n.id)), onclick: () => { S.treeCollapsed.has(n.id) ? S.treeCollapsed.delete(n.id) : S.treeCollapsed.add(n.id); lsSet("pravaha.treeCollapsed", [...S.treeCollapsed]); renderChrome(); } }, icon("chev", 14)) : h("span", { class: "chev" });
    const cur = S.tab === "feed" && S.scope === n.id; const top = isTopFolder(n);
    const row = h("div", { class: "trow" + (S.moved === n.id ? " dropped" : ""), "data-id": n.id, "data-grab": top ? "true" : null, style: { paddingLeft: n.depth * 14 + "px" }, oncontextmenu: (e) => openCtx(e, n.id) }, chev,
      h("button", { class: "tbtn", "aria-current": cur ? "true" : null, "aria-keyshortcuts": top ? "Alt+ArrowUp Alt+ArrowDown" : null, title: top ? "Drag to move this folder. Right-click for more." : null,
        onclick: () => open(n.id), onkeydown: top ? (e) => { if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveNode(n.id, e.key === "ArrowUp" ? "up" : "down", true); } } : null,
        onpointerdown: top ? (e) => startDrag(e, n, row) : null },
        n.type === "feed" ? iconFor(Number(n.id.slice(5)), n.label) : null, h("span", { class: "lbl" }, n.label), n.state && n.state !== "green" ? h("span", { class: "dot " + n.state, title: "This feed has trouble in Miniflux" }) : null, n.unread ? h("span", { class: "n" }, n.unread) : null));
    return row;
  });
  const base = String((S.settings && S.settings.miniflux && S.settings.miniflux.url) || "").replace(/\/+$/, "");
  return h("aside", { class: "side", "aria-label": "Folders and feeds" },
    h("div", { class: "sidehead" }, h("span", { class: "grow" }, "Folders"),
      h("button", { class: "ibtn", "data-act": "addfeed", title: "Add a feed from a website (a)", "aria-label": "Add a feed", onclick: () => openAddFeed() }, icon("plus", 18))),
    h("div", { class: "trow", "data-id": "all", oncontextmenu: (e) => openCtx(e, "all") }, h("span", { class: "chev" }), h("button", { class: "tbtn", "aria-current": S.tab === "feed" && S.scope === "all" ? "true" : null, onclick: () => open("all") }, icon("list", 16), h("span", { class: "lbl" }, "All articles"), S.unread ? h("span", { class: "n" }, S.unread) : null)),
    rows,
    h("p", { class: "sidenote", "data-note": "feed-order" }, "Drag a folder to move it, or press Alt with the up and down arrows. Feeds are listed alphabetically inside each folder; their names and folders are set in ",
      base ? h("a", { href: base + "/feeds", target: "_blank", rel: "noopener noreferrer" }, "Miniflux") : "Miniflux", "."));
}
// ---------- folder order: drag, keys and menu ----------
// A move is shown at once on the page and then confirmed by the background page. Nothing is rebuilt unless the two disagree.
const rowNodeEl = (id) => [...document.querySelectorAll(".side .trow[data-id]")].find(r => r.dataset.id === id);
const focusNode = (id) => rowNodeEl(id)?.querySelector(".tbtn")?.focus();
function renderSide() {
  const body = $app.querySelector(".body"); const old = body && body.querySelector(".side"); if (!old) return renderChrome();
  const keep = old.scrollTop; const fresh = sideBar(); old.replaceWith(fresh); fresh.scrollTop = keep;
}
// The tree is a flat list. Each top-level folder owns the rows after it, up to the next top-level folder.
function orderTree(tree, ids) {
  const blocks = new Map(); const head = []; let cur = null;
  for (const n of tree) { if (isTopFolder(n)) { cur = []; blocks.set(n.id, cur); } (cur || head).push(n); }
  const out = [...head]; const seen = new Set();
  for (const id of ids) if (blocks.has(id) && !seen.has(id)) { seen.add(id); out.push(...blocks.get(id)); }
  for (const [id, b] of blocks) if (!seen.has(id)) out.push(...b);
  const tops = out.filter(isTopFolder); tops.forEach((n, i) => { n.first = i === 0; n.last = i === tops.length - 1; });
  return out;
}
// Puts `els` in the wanted order inside `host` by moving as few of them as possible: the longest run that is already in the right
// order stays where it is, and only the others are moved. Moving one folder past a few others therefore touches only the folder.
function placeInOrder(host, els, anchor) {
  const cur = new Map(); let k = 0; for (const c of host.children) cur.set(c, k++);
  const pos = els.map(e => cur.get(e)); const n = pos.length; if (!n) return;
  const tail = [], prev = new Array(n).fill(-1); // patience sorting for the longest increasing subsequence
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = tail.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[tail[mid]] < pos[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tail[lo - 1]; tail[lo] = i;
  }
  const keep = new Set(); for (let i = tail[tail.length - 1]; i >= 0; i = prev[i]) keep.add(i);
  let before = anchor;
  for (let i = 0; i < n; i++) { if (!keep.has(i)) { if (before) before.after(els[i]); else host.prepend(els[i]); } before = els[i]; }
}
function moveRows(side) {
  const by = new Map(); for (const el of side.querySelectorAll(".trow[data-id]")) by.set(el.dataset.id, el);
  placeInOrder(side, S.tree.map(n => by.get(n.id)).filter(Boolean), by.get("all"));
}
// The sections in the article list follow the folder order without asking for the whole list again.
function reorderGroups() {
  if (!S.data || S.data.search || S.ranked || !isFeedTab()) return;
  const pos = new Map(S.tree.map((n, i) => [n.id, i])); const gs = S.data.groups; const at = (g) => (pos.has(g.key) ? pos.get(g.key) : 1e9);
  gs.sort((a, b) => at(a) - at(b) || a.title.localeCompare(b.title));
  const host = gs.find(g => g.el && g.el.parentNode)?.el.parentNode; if (!host) return;
  placeInOrder(host, gs.map(g => g.el).filter(el => el && el.parentNode === host), null);
}
// A dropped folder slides from where it was let go to its place. Transform only, so it never forces layout while moving.
function glide(el, from) {
  if (!el || !el.isConnected) return; const dy = from - el.getBoundingClientRect().top; if (Math.abs(dy) < 2) return;
  el.style.transition = "none"; el.style.transform = `translate3d(0,${Math.round(dy)}px,0)`; void el.offsetHeight;
  el.style.transition = "transform .2s var(--ease)"; el.style.transform = "";
  const done = () => { el.style.transition = ""; }; el.addEventListener("transitionend", done, { once: true }); setTimeout(done, 280);
}
function settleTree(tree) {
  if (!tree) return; const same = tree.length === S.tree.length && tree.every((x, i) => x.id === S.tree[i].id);
  S.tree = tree; if (!same) { renderSide(); reorderGroups(); }
}
async function commitOrder(ids, el, from) {
  const side = $app.querySelector(".side"); const before = S.tree.map(x => x.id).join("|");
  S.tree = orderTree(S.tree, ids); const changed = S.tree.map(x => x.id).join("|") !== before;
  if (side && changed) moveRows(side);
  if (el) glide(el, from);
  if (!changed) return;
  if (el) { el.classList.add("dropped"); setTimeout(() => el.classList.remove("dropped"), 900); }
  setTimeout(reorderGroups, 240);
  try { settleTree((await send({ type: "reorderFolders", ids })).tree); } catch { settleTree(((await send({ type: "tree" }).catch(() => null)) || {}).tree); }
}
async function moveNode(id, dir, keepFocus) {
  const tops = S.tree.filter(isTopFolder).map(x => x.id); const i = tops.indexOf(id), j = i + (dir === "up" ? -1 : 1); if (i < 0 || j < 0 || j >= tops.length) return;
  [tops[i], tops[j]] = [tops[j], tops[i]]; const el = rowNodeEl(id);
  await commitOrder(tops, el, el ? el.getBoundingClientRect().top : 0); if (keepFocus) focusNode(id);
}
// Dragging a top-level folder. A pointer must travel a few pixels first, so a plain click still opens the folder.
// Everything is measured once when the drag begins. After that each frame only does arithmetic and writes two transforms.
function startDrag(e, n, row) {
  if (e.button !== 0 || S.dialog) return;
  const side = row.closest(".side"); const x0 = e.clientX, y0 = e.clientY;
  let on = false, line = null, shield = null, blocks = [], own = -1, idx = -1, py = y0, raf = 0, base = 0, sideTop = 0, minDy = 0, maxDy = 0, still = null;
  const frame = () => {
    raf = 0; if (!on) return;
    const rel = py - sideTop, sh = side.clientHeight; let sp = 0;
    if (side.scrollHeight <= sh) { /* nothing to scroll */ } else if (rel < 40) sp = -Math.ceil((40 - Math.max(rel, 0)) / 40 * 14); else if (rel > sh - 40) sp = Math.ceil((40 - Math.max(sh - rel, 0)) / 40 * 14);
    if (sp) side.scrollTop += sp;
    const cy = rel + side.scrollTop; let i = 0; while (i < blocks.length && cy >= blocks[i].mid) i++; idx = i;
    const y = i < blocks.length ? blocks[i].top : blocks[blocks.length - 1].bottom;
    line.style.transform = `translate3d(0,${Math.round(y - 1)}px,0)`;
    row.style.transform = `translate3d(0,${Math.round(Math.max(minDy, Math.min(maxDy, py - y0 + side.scrollTop - base)))}px,0)`;
    const st = idx === own || idx === own + 1; if (st !== still) { still = st; line.dataset.still = String(st); }
    if (sp) raf = requestAnimationFrame(frame);
  };
  const begin = () => {
    const byId = new Map(S.tree.map(x => [x.id, x])); const sr = side.getBoundingClientRect(); sideTop = sr.top; base = side.scrollTop;
    for (const el of side.querySelectorAll(".trow[data-id]")) {
      const nd = byId.get(el.dataset.id); if (!nd) continue; const r = el.getBoundingClientRect(); const top = r.top - sr.top + base, bottom = r.bottom - sr.top + base;
      if (isTopFolder(nd)) blocks.push({ id: nd.id, top, bottom, mid: 0 }); else if (nd.parent && blocks.length) blocks[blocks.length - 1].bottom = bottom;
    }
    own = blocks.findIndex(b => b.id === n.id); if (own < 0) return false;
    for (const b of blocks) b.mid = (b.top + b.bottom) / 2;
    minDy = blocks[0].top - blocks[own].top; maxDy = blocks[blocks.length - 1].bottom - blocks[own].top - row.offsetHeight;
    on = true; document.body.classList.add("dragging-folder"); row.classList.add("lift");
    shield = h("div", { class: "dragshield", "aria-hidden": "true" }); document.body.append(shield);
    line = h("div", { class: "dropline", "aria-hidden": "true" }); side.append(line); frame(); return true;
  };
  const cleanup = () => {
    on = false; if (raf) cancelAnimationFrame(raf); raf = 0;
    document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging-folder"); row.classList.remove("lift"); line?.remove(); shield?.remove();
  };
  const move = (ev) => {
    py = ev.clientY;
    if (!on) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6 || !begin()) return; }
    ev.preventDefault(); if (!raf) raf = requestAnimationFrame(frame);
  };
  const finish = (go, ev) => {
    const was = on; if (raf) cancelAnimationFrame(raf); raf = 0;
    if (was && go && ev) { py = ev.clientY; frame(); if (raf) cancelAnimationFrame(raf); raf = 0; }
    const at = idx; const from = row.getBoundingClientRect().top; cleanup(); row.style.transform = "";
    if (!was) return;
    const stop = (c) => { c.stopPropagation(); c.preventDefault(); }; window.addEventListener("click", stop, { capture: true, once: true }); setTimeout(() => window.removeEventListener("click", stop, true), 60);
    const ids = blocks.map(b => b.id); if (go && at >= 0) { const f = ids.indexOf(n.id); ids.splice(f, 1); ids.splice(at > f ? at - 1 : at, 0, n.id); }
    commitOrder(ids, row, from);
  };
  const up = (ev) => finish(true, ev); const cancel = () => finish(false); const key = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); finish(false); } };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", cancel); document.addEventListener("keydown", key, true);
}
// The right-click menu on the folder list.
function closeCtx() { document.querySelector(".ctxmenu")?.remove(); document.removeEventListener("pointerdown", ctxAway, true); document.removeEventListener("keydown", ctxKey, true); window.removeEventListener("blur", closeCtx); window.removeEventListener("resize", closeCtx); }
const ctxAway = (e) => { if (!e.target.closest || !e.target.closest(".ctxmenu")) closeCtx(); };
const ctxKey = (e) => {
  const m = document.querySelector(".ctxmenu"); if (!m) return; const items = [...m.querySelectorAll("button:not([disabled])")]; const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const back = m.dataset.from; closeCtx(); focusNode(back || "all"); }
  else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === "Tab") { e.preventDefault(); closeCtx(); }
};
async function markNodeRead(id) {
  const node = id === "all" ? null : S.tree.find(x => x.id === id); const n = id === "all" ? S.unread : node ? node.unread : 0;
  if (!n) return toast("Nothing to mark: everything here is already read.", { kind: "info" });
  const where = id === "all" ? "in every folder" : `in “${node.label}”`;
  if (!(await confirmIf("bulk", `Mark all ${plural(n)} ${where} as read?`))) return;
  await bulkRead([], id); if (isFeedTab()) loadView();
}
function openCtx(e, id) {
  e.preventDefault(); closeCtx(); const node = id === "all" ? null : S.tree.find(x => x.id === id); if (!node && id !== "all") return;
  const unread = id === "all" ? S.unread : node.unread; const label = id === "all" ? "All articles" : node.label;
  const item = (act, text, fn, o = {}) => h("button", { role: "menuitem", class: "ctxitem", "data-act": act, disabled: o.off ? true : null, onclick: () => { closeCtx(); fn(); } }, h("span", {}, text), o.note ? h("small", {}, o.note) : null);
  const items = [item("mark-read", "Mark all read", () => markNodeRead(id), { off: !unread, note: unread ? String(unread) : "none unread" })];
  const fid = node && node.type === "feed" ? Number(node.id.slice(5)) : null;
  items.push(h("div", { class: "ctxsep", role: "separator" }));
  if (id === "all") items.push(item("refresh-all", "Refresh every feed", () => refreshScope("all")));
  else if (fid) items.push(item("feed-refresh", "Refresh now", () => feedAct.refresh(fid)), item("feed-rename", "Rename…", () => feedAct.rename(fid)), item("feed-move", "Move to folder…", () => feedAct.move(fid)), item("feed-delete", "Delete…", () => feedAct.remove(fid)));
  else items.push(item("folder-refresh", "Refresh now", () => refreshScope(id)), item("folder-rename", "Rename folder…", () => folderRename(id)));
  if (isTopFolder(node)) items.push(h("div", { class: "ctxsep", role: "separator" }), item("move-up", "Move up", () => moveNode(id, "up"), { off: node.first }), item("move-down", "Move down", () => moveNode(id, "down"), { off: node.last }));
  const menu = h("div", { class: "ctxmenu", role: "menu", "aria-label": label, "data-from": id }, h("div", { class: "ctxhead" }, label), ...items);
  document.body.append(menu); const w = menu.offsetWidth, hh = menu.offsetHeight;
  const x = e.clientX || e.target.getBoundingClientRect().left + 20, y = e.clientY || e.target.getBoundingClientRect().top + 10;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + "px"; menu.style.top = Math.max(6, Math.min(y, window.innerHeight - hh - 6)) + "px";
  document.addEventListener("pointerdown", ctxAway, true); document.addEventListener("keydown", ctxKey, true); window.addEventListener("blur", closeCtx); window.addEventListener("resize", closeCtx);
  (menu.querySelector("button:not([disabled])") || menu).focus();
}
function toggleBionic() { setPref({ anchor: !U.anchor }); renderChrome(); toast(U.anchor ? "Bionic reading is on." : "Bionic reading is off.", { kind: "info" }); }
// A redraw must not take the cursor out of the search box while someone is typing in it.
function keepSearchFocus(fn) {
  const a = document.activeElement; const keep = a && a.matches && a.matches(".search input") ? a.selectionStart : null; fn();
  if (keep !== null) { const i = $app.querySelector(".search input"); if (i) { i.focus(); try { i.setSelectionRange(keep, keep); } catch { /* ignore */ } } }
}
function renderChrome() {
  noteImport(S.status);
  const body = $app.querySelector(".body"); if (!body) return render();
  keepSearchFocus(() => { $app.querySelector(".top")?.replaceWith(topBar()); const side = body.querySelector(".side"); if (side) { const keep = side.scrollTop; const fresh = sideBar(); side.replaceWith(fresh); fresh.scrollTop = keep; } body.dataset.side = U.side ? "on" : "off"; });
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
const SHORTCUTS = [["j / k", "Next or previous article (opens it if a card is open)"], ["o or Enter", "Read here as a card"], ["b", "Open in a background tab, counted as interest"], ["w", "Fetch the full article (the coffee button)"], ["s", "Save or unsave"], ["+ / -", "Thumbs up or down: more or less like this article"], ["x", "Dismiss"], ["m", "Mark read or unread"], ["Shift+A", "Mark the section read and fold it (works without a selection)"], ["Shift+M", "Mark everything in this view read"], ["Shift+B", "Bionic reading on or off"], ["a", "Add a feed from a website"], ["c", "Fold or unfold the section"], ["Shift+C", "Fold or unfold every section"], ["u", "Switch between Unread and All"], ["r", "Sync now"], ["/", "Search"], ["Esc", "Close the card or this panel"], ["?", "Show this list"]];
function renderOverlay() {
  $app.querySelector(".overlay")?.remove(); if (!S.help) return;
  $app.append(h("div", { class: "overlay", onclick: () => { S.help = false; renderOverlay(); } }, h("div", { class: "dialog", role: "dialog", "aria-label": "Keyboard shortcuts", onclick: (e) => e.stopPropagation() }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, d]) => h("div", {}, h("span", {}, d), h("kbd", {}, k)))), h("p", { class: "note", style: { marginTop: "12px" } }, "Shortcuts pause while you type in a box."))));
}

// ---------- main area ----------
function render() {
  const view = tm("feedMain", () => isFeedTab() ? feedMain() : S.tab === "stats" ? statsMain() : S.tab === "sync" ? syncMain() : settingsMain());
  const body = h("div", { class: "body", "data-side": U.side ? "on" : "off" }, tm("sideBar", sideBar), h("main", { class: "main" }, view));
  keepSearchFocus(() => { tm("replaceChildren", () => $app.replaceChildren(topBar(), body)); renderPop(); renderOverlay(); tm("afterMain", afterMain); });
}
function renderMain() { const m = $app.querySelector(".main"); if (!m) return render(); m.replaceChildren(...(isFeedTab() ? feedMain() : S.tab === "stats" ? statsMain() : S.tab === "sync" ? syncMain() : settingsMain())); afterMain(); }
function afterMain() {
  const sub = $app.querySelector(".sub"); const topH = 52 + (sub ? sub.getBoundingClientRect().height : 0);
  // A custom property set on the root restyles every element, so it is written only when the value really changed.
  const gh = Math.round(topH) + "px"; if (document.documentElement.style.getPropertyValue("--ghead-top") !== gh) document.documentElement.style.setProperty("--ghead-top", gh);
  if (S.openCard && S.rows.has(S.openCard)) { const r = S.rows.get(S.openCard); const el = rowElById(r.id); if (el) { el.dataset.card = "true"; fillCard(r); } }
  showBanner(); observeRows(); anchorSamples(); kickFill();
}

// ---------- stats ----------
const hbar = (name, value, max, color, label) => h("div", { class: "hbar" }, h("span", { class: "name", title: name }, name), h("span", { class: "track" }, h("i", { style: { width: (max ? value / max * 100 : 0) + "%", background: color } })), h("span", { class: "val" }, label != null ? label : String(value)));
function statsMain() {
  const s = S.stats; if (!s) return [h("div", { class: "empty" }, "Loading")];
  const tiles = [["Read in the reader", s.cards], ["Opened in tabs", s.opens], ["Saved", s.saves], ["Dismissed", s.dismisses], ["Minutes reading", s.dwellMinutes]].map(([n, v]) => h("div", { class: "stat" }, h("b", {}, String(v)), h("span", {}, n + ", last 30 days")));
  const maxB = Math.max(1, ...s.bands.map(b => b.n)); const maxO = Math.max(1, ...s.bands.map(b => b.opened));
  const col = (b) => gradeOf((b.lo + b.hi) / 2).bg;
  const rules = S.rules.length ? S.rules.map(r => h("div", { class: "trainrow" }, h("span", { class: "kw", "data-v": String(Math.sign(r.value)) }, `${r.type}: ${r.key}`), h("span", {}, r.value > 0 ? "more" : "less"), h("button", { class: "kw", onclick: async () => { await train(r.type, r.key, 0); go("stats"); } }, "Remove"))) : [h("p", { class: "note" }, "No training yet. Use the thumbs on an article, or click the tags and words under its title.")];
  const folders = s.savesByFolder.length ? s.savesByFolder.map(([n, v]) => hbar(n, v, Math.max(1, ...s.savesByFolder.map(x => x[1])), "var(--accent)")) : [h("p", { class: "note" }, "Nothing saved in the last 30 days.")];
  return [h("div", { class: "page" }, h("h1", {}, "Reading stats"), h("div", { class: "tiles" }, tiles),
    h("div", { class: "cols" },
      h("div", { class: "panel" }, h("h2", {}, "Articles by relevance"), s.bands.map(b => hbar(`${pct(disp(b.lo))} to ${pct(disp(b.hi))}`, b.n, maxB, col(b), String(b.n))), h("p", { class: "note" }, "Darker means more relevant.")),
      h("div", { class: "panel" }, h("h2", {}, "Share opened, by relevance"), s.bands.map(b => hbar(`${pct(disp(b.lo))} to ${pct(disp(b.hi))}`, b.opened, maxO, col(b), b.n ? Math.round(b.opened / b.n * 100) + "%" : "0%")), h("p", { class: "note" }, "If the darker bands are opened more often, the ranking is working for you.")),
      h("div", { class: "panel" }, h("h2", {}, "Feed standing"), s.league.map(f => hbar(f.title, f.authority, 1, gradeOf(f.authority).bg, String(pct(f.authority)))), h("p", { class: "note" }, "Rises when you read and save a feed, falls when you skip or dismiss it.")),
      h("div", { class: "panel" }, h("h2", {}, "Saves by folder"), folders), h("div", { class: "panel" }, h("h2", {}, "Your training rules"), rules)))];
}

// ---------- sync ----------

// ---------- page chrome: folder tabs, status lamps, gauges and small graphs ----------
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); for (const k of kids) if (k) e.append(k); return e; };
const STATE_WORD = { green: "Good", amber: "Catching up", red: "Needs attention", off: "Off" };
const worstOf = (states) => { const R = { off: 0, green: 1, amber: 2, red: 3 }; const live = states.filter(x => x && x !== "off"); return live.length ? live.reduce((a, b) => (R[b] > R[a] ? b : a)) : "off"; };
// A row of tabs shaped like folder tabs. The chosen one joins the sheet below it; each can carry an icon and a status lamp.
function folderTabs(items, active, onPick, label) {
  return h("div", { class: "stabs", role: "tablist", "aria-label": label }, items.map(it => h("button", { class: "stab", role: "tab", "data-tab": it.id, "aria-selected": String(active === it.id), title: it.lamp ? `${it.label}: ${STATE_WORD[it.lamp]}` : it.label, onclick: () => onPick(it.id) },
    icon(it.icon, 17), h("span", { class: "stl" }, it.label), it.lamp ? h("span", { class: "lamp " + it.lamp, "aria-label": STATE_WORD[it.lamp] }) : null)));
}
// The sheet slides in once when a tab is chosen, not on every redraw (a redraw that replayed it would flash).
const sheet = (id, ...kids) => { const key = S.tab + ":" + id; const fresh = S.lastSheet !== key; S.lastSheet = key; return h("div", { class: "sheet" + (fresh ? " enter" : ""), role: "tabpanel", "data-sheet": id }, ...kids); };
function pageHead(title, sub) { return h("header", { class: "phead" }, h("h1", {}, title), sub ? h("p", {}, sub) : null); }
// A ring that shows a share of something. Static: it is drawn once and never animates on its own.
function ring(frac, state, centre, small, label) {
  const R = 46, C = 2 * Math.PI * R; const f = Math.max(0, Math.min(1, frac));
  return h("div", { class: "ring " + state, role: "img", "aria-label": label || "" }, svgEl("svg", { viewBox: "0 0 120 120", width: small ? 76 : 132, height: small ? 76 : 132, "aria-hidden": "true" },
    svgEl("circle", { class: "rtrack", cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 9 }), svgEl("circle", { class: "rarc", cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 9, "stroke-linecap": "round", "stroke-dasharray": `${(C * f).toFixed(1)} ${C.toFixed(1)}`, transform: "rotate(-90 60 60)" })),
    h("div", { class: "rmid" }, centre));
}
// A tiny area graph from a list of numbers. The last point wears a dot.
function areaGraph(points, label, unit) {
  const W = 300, Hh = 64; const max = Math.max(1, ...points);
  if (points.length < 2) return h("p", { class: "note graphnote" }, "The graph appears after a few syncs.");
  const xy = points.map((v, i) => [(i / (points.length - 1)) * W, Hh - 6 - (v / max) * (Hh - 14)]); const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1];
  return svgEl("svg", { class: "area", viewBox: `0 0 ${W} ${Hh}`, preserveAspectRatio: "none", role: "img", "aria-label": `${label}. Latest ${points[points.length - 1]} ${unit}. Highest ${max}.` },
    svgEl("polygon", { class: "afill", points: `0,${Hh} ${line} ${W},${Hh}` }), svgEl("polyline", { class: "aline", points: line, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }), svgEl("circle", { class: "adot", cx: last[0], cy: last[1], r: 3.2 }));
}
const tile = (state, icn, title, big, sentence, foot, extra) => h("div", { class: "tile light", "data-state": state },
  h("div", { class: "thead" }, h("span", { class: "tico" }, icon(icn, 18)), h("b", {}, title), h("span", { class: "lamp " + state, title: STATE_WORD[state] })), big != null ? h("div", { class: "tbig" }, big) : null, h("p", { class: "tsent" }, sentence), extra || null, foot ? h("div", { class: "tfoot" }, foot) : null);

// The Miniflux server tile: the version, whether its answers still look the way Pravaha expects, and a read-only self-check.
const kb = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
async function ackServer() { try { S.status = await send({ type: "serverAck" }); } catch { return; } renderMain(); renderChrome(); toast("Noted. The server change is acknowledged.", { kind: "success" }); }
async function checkServer() {
  if (S.serverBusy) return; S.serverBusy = true; S.serverLines = null; renderMain();
  try { const r = await send({ type: "serverCheck" }); S.serverLines = r.lines; S.status = r.status; } catch { S.serverLines = [{ state: "red", text: "The check could not run. The background page did not answer." }]; }
  S.serverBusy = false; renderMain(); renderChrome();
}
function serverTile() {
  const st = S.status; const x = st && st.lights.find(l => l.id === "server"); if (!x) return null; const sv = st.server || {};
  const how = sv.mode === "light" ? "light refresh" : sv.mode === "full" ? "full refresh" : null;
  const foot = how ? `Last refresh: ${how}, ${sv.calls} request${sv.calls === 1 ? "" : "s"}, ${kb(sv.bytes || 0)}` : null;
  const lines = S.serverLines ? h("ul", { class: "checks", "data-checks": "1", "aria-label": "Server check results" }, S.serverLines.map(l => h("li", { "data-state": l.state }, h("span", { class: "lamp " + l.state }), h("span", {}, l.text)))) : null;
  const acts = h("div", { class: "tacts" }, sv.changed ? h("button", { class: "btn small primary", "data-act": "server-ack", onclick: ackServer }, "Got it") : null,
    h("button", { class: "btn small", "data-act": "server-check", disabled: S.serverBusy ? true : null, onclick: checkServer }, S.serverBusy ? "Checking" : "Check server"));
  return tile(x.state, "gauge", "Miniflux server", sv.version || "unknown", x.sentence, foot, h("div", {}, acts, lines));
}
function syncMain() {
  const st = S.status; if (!st) return [h("div", { class: "empty" }, "Loading")]; const l = st.left || {}; const machines = Array.isArray(l.machines) ? l.machines : [];
  const lightOf = (id) => st.lights.find(x => x.id === id); const n = (l.events || 0) + (l.ops || 0);
  const fx = S.fx; const fxState = !fx ? "off" : fx.error || !fx.readable ? "red" : worstOf(fx.parts.map(p => fxLine(p)[0]));
  const devices = st.devices || []; const others = devices.filter(d => !d.me); const macState = worstOf(devices.length > 1 ? others.map(d => d.state) : []);
  const tab = S.ytab || "overview";
  const tabs = folderTabs([{ id: "overview", label: "Overview", icon: "gauge", lamp: st.overall }, { id: "firefox", label: "Firefox Sync", icon: "sync", lamp: fxState }, { id: "machines", label: "Machines", icon: "devices", lamp: macState }], tab, (id) => { S.ytab = id; renderMain(); }, "Sync sections");
  let body;
  if (tab === "firefox") body = firefoxSheet(fxState);
  else if (tab === "machines") body = machinesSheet(devices);
  else {
    const hist = (S.stats && S.stats.pendingHistory) || []; const peak = Math.max(1, n, ...hist.map(p => p.pending));
    const act = st.activity; const frac = act && act.total ? Math.min(1, act.done / act.total) : st.overall === "off" ? 0 : n ? Math.max(0.04, 1 - n / peak) : 1;
    const headline = st.overall === "green" ? "All in sync" : st.overall === "red" ? "Something needs attention" : st.overall === "amber" ? "Catching up" : "Not set up yet";
    const sub = `${n ? `${n} change${n === 1 ? "" : "s"} still to sync` : "Nothing left to sync"}${machines.length ? `. Other machines: ${machines.map(m => m.device || "machine").join(", ")}.` : "."}`;
    const total = devices.reduce((a, d) => a + d.events, 0);
    const svc = (id, icn, title) => { const x = lightOf(id); return x ? tile(x.state, icn, title, null, x.sentence) : null; };
    body = [h("div", { class: "hero dash", "data-state": st.overall }, ring(frac, st.overall, st.overall === "green" ? icon("check", 40) : h("span", { class: "rnum" }, String(n)), false, headline),
      h("div", { class: "herotext" }, h("p", { class: "eyebrow" }, "Sync status"), h("h2", {}, headline), h("p", {}, sub), st.activity ? h("p", { class: "note" }, `${st.activity.label}${st.activity.total ? `: ${Math.min(st.activity.done, st.activity.total)} of ${st.activity.total}` : ""}`) : null,
        h("div", { class: "heroact" }, h("button", { class: "btn primary", onclick: syncNow }, icon("sync", 15), S.busy ? "Syncing" : "Sync now"), h("button", { class: "btn", onclick: async () => { const r = await send({ type: "digest" }); toast(r.sentence); } }, "Write digest now")))),
      h("div", { class: "tiles" }, svc("miniflux", "rss", "Miniflux"), serverTile(), svc("webdav", "layers", "WebDAV storage"), svc("log", "clock", "Reading history"), svc("raindrop", "bookmark", "Raindrop"), svc("feeds", "list", "Feeds"),
        tile(fxState, "sync", "Firefox Sync", null, !fx ? "Reading Firefox Sync." : fx.error ? fx.error : fx.parts.map(p => fxLine(p)[1]).slice(0, 1).join(""), null, h("div", { class: "fxbar", role: "img", "aria-label": "The four parts Firefox Sync carries" }, (fx ? fx.parts : [{}, {}, {}, {}]).map(p => h("i", { "data-s": p.part ? fxLine(p)[0] : "off", title: p.part ? FX_NAMES[p.part] : "" }))))),
      h("div", { class: "graphs" }, h("div", { class: "gcard" }, h("div", { class: "gtitle2" }, h("b", {}, "Changes waiting"), h("span", {}, n ? `${n} now` : "none now")), areaGraph(hist.map(p => p.pending), "Changes waiting to sync over time", "changes")),
        h("div", { class: "gcard" }, h("div", { class: "gtitle2" }, h("b", {}, "History on the storage"), h("span", {}, `${total.toLocaleString()} events`)),
          total ? h("div", { class: "stack", role: "img", "aria-label": devices.map(d => `${d.device}: ${d.events} events`).join(". ") }, devices.map((d, i) => h("i", { style: { flexGrow: String(Math.max(d.events, 0.01)) }, "data-i": String(i % 4), title: `${d.device}: ${d.events.toLocaleString()} events` }))) : h("p", { class: "note graphnote" }, "Nothing recorded yet."),
          total ? h("div", { class: "legend" }, devices.map((d, i) => h("span", {}, h("i", { "data-i": String(i % 4) }), `${d.device || "machine"} ${d.events.toLocaleString()}`))) : null))];
  }
  return [h("div", { class: "page" }, pageHead("Sync", "Where everything stands, in one place."), tabs, sheet(tab, ...body))];
}
function firefoxSheet(state) {
  const fx = S.fx; const parts = fx ? fx.parts : [];
  const cells = parts.map(p => { const [lamp, text] = fxLine(p); return h("div", { class: "cell", "data-state": lamp }, h("span", { class: "lamp " + lamp }), h("b", {}, FX_NAMES[p.part]), h("span", {}, text)); });
  return [h("div", { class: "cells", "aria-label": "What Firefox Sync carries" }, cells.length ? cells : [h("p", { class: "note" }, "Reading Firefox Sync.")]), fxCard()];
}
function machinesSheet(devices) {
  const max = Math.max(1, ...devices.map(d => d.events));
  if (!devices.length) return [h("p", { class: "note" }, "No machine has written history yet.")];
  return [h("div", { class: "tiles machines" }, devices.map(d => h("div", { class: "tile machine", "data-me": String(d.me), "data-state": d.state },
    h("div", { class: "thead" }, h("span", { class: "tico" }, icon("laptop", 18)), h("b", {}, d.device || "machine"), d.me ? h("span", { class: "badge" }, "This machine") : null, h("span", { class: "lamp " + d.state, title: STATE_WORD[d.state] })),
    h("div", { class: "tbig" }, d.events.toLocaleString(), h("small", {}, d.events === 1 ? " event" : " events")), h("div", { class: "meter", role: "img", "aria-label": `${d.events} of ${max} events, relative to the largest machine` }, h("i", { style: { width: Math.round(d.events / max * 100) + "%" } })),
    h("p", { class: "tsent" }, d.me ? (d.state === "green" ? "Everything on this machine is on the storage." : "Some changes here have not reached the storage yet.") : d.behind ? "Has not yet received your latest changes. It catches up when it next opens." : d.ahead ? "Has changes this machine has not read yet." : "Up to date."),
    d.lastSeenAt ? h("div", { class: "tfoot" }, "Last connected " + since(d.lastSeenAt)) : null)))];
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
  const fxText = !fx ? "Looking in Firefox Sync." : !fx.readable ? "Firefox Sync storage could not be read in this browser." : found.length ? `Found a setup saved${by ? ` by ${by}` : ""} ${since(Math.max(...found.map(p => p.remote.at)))}. It is applied automatically; if it has not appeared, press Fetch.` : "Nothing yet. On your other machine open Settings, Move setup and press Send. Firefox Sync must be signed in here with Add-ons ticked. Firefox sends extension data about every 10 minutes; choose Sync Now in Firefox on both machines to hurry it.";
  return h("div", { class: "hero setup" }, h("h2", {}, "Set up this machine"),
    h("p", {}, "Pick whichever is easiest. Everything arrives the same way: keys first, then your articles from Miniflux, then your reading history from the WebDAV storage."),
    h("div", { class: "routes" },
      h("div", { class: "route", "data-route": "firefox-sync" }, h("h3", {}, "1. From Firefox Sync"), h("p", {}, fxText), h("button", { class: "btn", "data-act": "fx-pull", onclick: () => fxAct("pull", false) }, "Check Firefox Sync now")),
      h("div", { class: "route", "data-route": "file" }, h("h3", {}, "2. From a file or pasted text"), h("p", {}, "Made on your other machine with Settings, Move setup, Export or Copy as text. This route does not need Firefox Sync."), h("button", { class: "btn", "data-act": "go-move", onclick: () => { S.stab = "move"; renderMain(); } }, "Import a file or text")),
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
    h("div", { class: "grid2" }, h("div", { class: "field" }, "Theme", h("div", { class: "seg" }, THEMES.map(t => h("button", { "aria-pressed": String(U.theme === t), title: THEME_NAMES[t], onclick: (e) => { setPref(themePatch(t)); renderMain(); renderChrome(); } }, THEME_NAMES[t].split(" ")[0])))),
      h("div", { class: "field" }, "Relevance colours", h("div", { class: "seg" }, PALETTE_NAMES.map(p => h("button", { "aria-pressed": String(U.palette === p), onclick: () => { setPref({ palette: p }); renderMain(); } }, p[0].toUpperCase() + p.slice(1))))),
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
  else if (tab === "ranking") content = [h("div", { class: "panel" }, h("h2", {}, "Relevance weights"), ...[["tag", "Tag match"], ["echo", "Sites you read"], ["authority", "Feed standing"], ["freshness", "Freshness"], ["hot", "Covered by several feeds"]].map(([k, l]) => { if (!Number.isFinite(d.weights[k])) d.weights[k] = 0.1; const out = h("span", {}, pct(d.weights[k])); return h("label", { class: "range" }, h("span", {}, l), h("input", { type: "range", min: 0, max: 1, step: 0.05, value: d.weights[k], oninput: (e) => { d.weights[k] = Number(e.target.value); out.textContent = pct(d.weights[k]); markDirty(); } }), out); }),
    h("p", { class: "note" }, "Only the proportions matter. They are rescaled to add up to one when saved. Feed standing is the share of a feed's articles you open or save, not how many, so a busy feed cannot rank on volume. A signal with nothing behind it yet (no browsing history, no story covered twice) hands its weight to the others."), chk("Boost feeds I have not opened this session", d, "novelty"))];
  else if (tab === "feeds") content = feedsMain();
  else if (tab === "move") content = moveMain();
  else if (tab === "machine") content = [h("div", { class: "panel" }, h("h2", {}, "This machine"), h("div", { class: "grid2" }, inp("Machine name (set once, keep it)", d, "device"), inp("Check for new articles every (minutes)", d, "pollMinutes", "number"), inp("Keep read articles for (days)", d, "retentionDays", "number")), chk("Write the weekly digest automatically", d, "autoDigest")), detectPanel()];
  else content = [h("div", { class: "panel" }, h("h2", {}, "Keyboard shortcuts"), h("div", { class: "keys" }, SHORTCUTS.map(([k, v]) => h("div", {}, h("span", {}, v), h("kbd", {}, k)))))];
  const needSave = tab === "connections" || tab === "ranking" || tab === "machine";
  const connLamp = S.status ? worstOf(S.status.lights.filter(x => x.id === "miniflux" || x.id === "webdav").map(x => x.state)) : "off";
  const feedsLamp = S.status ? ((S.status.lights.find(x => x.id === "feeds") || {}).state || null) : null;
  const fxl = S.fx ? (S.fx.error || !S.fx.readable ? "red" : worstOf(S.fx.parts.map(p => fxLine(p)[0]))) : null;
  const tabs = folderTabs([{ id: "connections", label: "Connections", icon: "link", lamp: connLamp }, { id: "look", label: "Look and reading", icon: "palette" }, { id: "feeds", label: "Feeds", icon: "rss", lamp: feedsLamp }, { id: "ranking", label: "Ranking", icon: "sliders" }, { id: "move", label: "Move setup", icon: "swap", lamp: fxl }, { id: "machine", label: "This machine", icon: "laptop", lamp: S.detect ? (S.detect.on ? "green" : "off") : null }, { id: "keys", label: "Shortcuts", icon: "keyboard" }], S.stab, (id) => { S.stab = id; renderMain(); }, "Settings sections");
  return [h("div", { class: "page" }, pageHead("Settings", "Connections, the way it looks, and how this machine behaves."),
    S.settings && !S.settings.miniflux.token ? setupHero() : null, tabs,
    sheet(tab, ...content, needSave ? h("div", { class: "savebar" }, h("button", { class: "btn primary", "data-save": "1", disabled: S.dirty ? null : true, onclick: saveDraft }, "Save and test"), h("button", { class: "btn", "data-gofeed": "1", hidden: !(S.settings && S.settings.miniflux.token), onclick: () => go("feed") }, "Open Newsfeed"), h("span", { class: "note" }, S.dirty ? "You have unsaved changes." : "Nothing to save.")) : null))];
}

// ---------- moving a setup between machines ----------
const FX_NAMES = { keys: "Keys", settings: "Settings", order: "Folder order", ui: "Look and fonts" };
function fxLine(p) {
  const by = p.remote && p.remote.by ? ` by ${p.remote.by}` : "";
  const mine = !!(p.remote && p.remote.by && S.settings && p.remote.by === S.settings.device);
  if (p.state === "absent") return ["off", "Nothing in Firefox Sync on this machine yet."];
  if (p.state === "level" && mine) return ["amber", `Written on this machine ${since(p.remote.at)}. Firefox sends it to your other machines on its next sync.`];
  if (p.state === "level") return ["green", `Arrived${by} ${since(p.remote.at)}.`];
  if (p.state === "remote-newer") return ["amber", `A newer copy${by} (${since(p.remote.at)}) is waiting. Fetch it below.`];
  return ["amber", "This machine has newer changes that Firefox Sync has not received. Send them below."];
}
async function fxAct(kind, force) {
  const r = await send({ type: kind === "pull" ? "profilePull" : "profilePush", force });
  if (!r) { toast("Firefox Sync is not available in this browser.", { kind: "error" }); return; }
  S.fx = r.summary;
  if (kind === "pull") {
    if (r.error) toast(r.error, { kind: "error" });
    else if (!r.applied.length) toast(Object.keys(r.found).length ? "This machine already has everything that Firefox Sync holds." : "Nothing has reached this machine from Firefox Sync yet. On the machine that has your keys, open Settings, Move setup and press Send, then choose Sync Now in Firefox on that machine and on this one.", { kind: "info" });
    else { const b = await send({ type: "boot" }); S.settings = b.settings; S.tree = b.tree; S.status = b.status; S.draft = null; adoptRemoteUi(b.settings); toast(`Took ${r.applied.map(a => PART_WORDS[a.part]).join(", ")} from Firefox Sync.`, { kind: "success" }); }
  } else toast(r.error ? r.error : r.sent && r.sent.length ? `Sent ${r.sent.map(x => PART_WORDS[x]).join(", ")} to Firefox Sync. It reaches your other machines when Firefox next syncs, about every 10 minutes, or at once if you choose Sync Now in Firefox.` : "Nothing to send yet. Fill in Connections first.", { kind: r.error ? "warn" : "success" });
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
    h("p", { class: "note" }, "Firefox Sync must be signed in on both machines, with Add-ons ticked under Settings, Sync, Change. Firefox sends extension data about every 10 minutes. To make it immediate, choose Sync Now in Firefox (the account icon, or Settings, Sync) on the sending machine first and then on the receiving machine. Machine names are never carried, so each machine keeps its own."));
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
  const copyNow = async () => {
    const r = await send({ type: "exportSettings", keys: ex.keys, passphrase: ex.pass, history: false, ui: U });
    if (!r.ok) return toast(r.sentence, { kind: "error" });
    let ok = false; try { await navigator.clipboard.writeText(r.text); ok = true; } catch { /* shown below instead */ }
    if (ok) { ex.shown = ""; toast(`Copied. On the other machine, paste it under Import${r.keys ? " and enter the same passphrase" : ""}.`, { kind: "success" }); } else { ex.shown = r.text; toast("Your browser did not allow copying. Select the text below and copy it yourself.", { kind: "warn" }); }
    renderMain();
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
    h("div", { class: "dfoot left" }, h("button", { class: "btn primary", "data-act": "export", onclick: exportNow }, "Export settings file"), h("button", { class: "btn", "data-act": "copy-text", onclick: copyNow }, "Copy as text instead")),
    ex.shown ? h("textarea", { class: "pastebox", readonly: "readonly", rows: "5", "data-exp": "shown", "aria-label": "Setup text to copy", onfocus: (e) => e.target.select() }, ex.shown) : null,
    h("p", { class: "note" }, "Copying as text leaves out the reading history. Paste the text into a note or message to yourself, then into Import on the other machine."),
    h("h3", {}, "Import"),
    h("label", { class: "field" }, "Settings file", h("input", { type: "file", accept: ".json,application/json", "data-act": "import-file", onchange: async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; im.name = f.name; im.text = await f.text(); im.needPass = /"keys":\s*\{/.test(im.text); im.pass = ""; renderMain(); } })),
    h("label", { class: "field" }, "Or paste setup text", h("textarea", { class: "pastebox", rows: "3", "data-imp": "paste", placeholder: "Paste the text copied on your other machine", oninput: (e) => { const v = e.target.value.trim(); im.text = v; im.name = "The pasted text"; const was = im.needPass; im.needPass = /"keys":\s*\{/.test(v); if (was !== im.needPass) renderMain(); } })),
    im.text ? h("p", { class: "note" }, `${im.name} is ready to import.`) : null,
    im.needPass ? h("label", { class: "field" }, "Passphrase for the keys in this file", h("input", { type: "password", autocomplete: "off", value: im.pass, "data-imp": "pass", oninput: (e) => { im.pass = e.target.value; } })) : null,
    h("div", { class: "dfoot left" }, h("button", { class: "btn primary", "data-act": "import", disabled: im.text ? null : true, onclick: importNow }, "Import")),
    h("p", { class: "note" }, "Importing replaces the matching settings on this machine and sends them on through Firefox Sync. It never changes this machine's name."));
}
function moveMain() { return [fxCard(), filePanel()]; }

// ---------- add a feed ----------
// Miniflux's own server looks at the page and lists its feeds; this extension never contacts the site itself.
// ---------- feed management ----------
// Every change is made in Miniflux first and only then shown here, so this page never claims something that Miniflux did not accept.
const FEED_PAGE = 100;
const folderPaths = () => S.tree.filter(n => n.type === "folder").map(n => n.id.slice(4)).sort((a, b) => a.localeCompare(b));
const catOf = (fid) => { const n = S.tree.find(x => x.id === "feed:" + fid); return n && n.parent ? n.parent.slice(4) : ""; };
const feedTitle = (fid) => { const n = S.tree.find(x => x.id === "feed:" + fid); if (n) return n.label; const f = (S.feedsInfo || []).find(x => x.id === fid); return f ? f.title : "this feed"; };
async function loadFeedsInfo() {
  try { S.feedsInfo = await send({ type: "feedsInfo" }); } catch { S.feedsInfo = S.feedsInfo || []; }
  if (S.tab === "settings" && S.stab === "feeds") fillFeedList();
}
// After a rename the folder's id changes, so anything the page remembers by id follows it.
function followId(from, to) {
  const re = (id) => id === from || id.startsWith(from + "/") ? to + id.slice(from.length) : id;
  S.treeCollapsed = new Set([...S.treeCollapsed].map(re)); lsSet("pravaha.treeCollapsed", [...S.treeCollapsed]); S.scope = re(S.scope);
}
async function manage(msg, after) {
  let r; try { r = await send(msg); } catch { return null; }
  if (r.tree) S.tree = r.tree;
  toast(r.sentence, { kind: r.ok ? (r.unchanged ? "info" : "success") : "error" });
  if (r.ok && after) after(r);
  if (isFeedTab()) { if (r.ok && !msg.type.startsWith("refresh")) loadView(); else renderChrome(); } else { renderChrome(); if (S.tab === "settings" && S.stab === "feeds") loadFeedsInfo(); }
  return r;
}
const feedAct = {
  async refresh(fid) { return manage({ type: "refreshScope", scope: "feed:" + fid }); },
  async rename(fid) {
    const cur = feedTitle(fid); const v = await askForm({ title: "Rename feed", body: "The new name is saved in Miniflux, so every machine and every app sees it.", label: "Name", value: cur, confirmLabel: "Rename" });
    if (typeof v !== "string" || !v.trim() || v.trim() === cur) return null; return manage({ type: "feedUpdate", id: fid, patch: { title: v } });
  },
  async move(fid) {
    const cur = catOf(fid) || (S.feedsInfo || []).find(x => x.id === fid)?.category || ""; const list = folderPaths(); if (cur && !list.includes(cur)) list.push(cur);
    const v = await askForm({ title: "Move feed", body: `Choose the folder for “${feedTitle(fid)}”. Folders are Miniflux categories; a folder inside another is written Parent/Child.`, kind: "folder", label: "Folder", options: list, value: cur, confirmLabel: "Move" });
    if (typeof v !== "string" || !v.trim() || v.trim() === cur) return null; return manage({ type: "feedUpdate", id: fid, patch: { category: v } });
  },
  async toggle(fid, disabled) { return manage({ type: "feedUpdate", id: fid, patch: { disabled: !disabled } }); },
  async remove(fid) {
    const t = feedTitle(fid); const info = (S.feedsInfo || []).find(x => x.id === fid);
    const v = await askForm({ title: "Delete this feed?", body: [`This deletes “${t}” and all of its articles from Miniflux. It cannot be undone.`, "If you only want it to stop being fetched, disable it instead. To delete, type the feed’s name exactly."], kind: "typed", expect: t, label: "Type the name to confirm", confirmLabel: "Delete feed", danger: true, alt: info && info.disabled ? null : "Disable instead" });
    if (v && v.alt) return feedAct.toggle(fid, false);
    if (typeof v !== "string") return null;
    return manage({ type: "feedDelete", id: fid, confirm: v }, () => { if (S.scope === "feed:" + fid) S.scope = "all"; });
  }
};
async function folderRename(id) {
  const path = id.slice(4); const leaf = path.split("/").pop(); const kids = S.tree.filter(n => n.type === "folder" && n.id.startsWith(id + "/")).length;
  const v = await askForm({ title: "Rename folder", body: kids ? `This also renames the ${kids} folder${kids === 1 ? "" : "s"} inside it, in Miniflux, one at a time.` : "The folder is renamed in Miniflux, so every machine and every app sees it.", label: "Name", value: leaf, confirmLabel: "Rename" });
  if (typeof v !== "string" || !v.trim() || v.trim() === leaf) return null;
  return manage({ type: "folderRename", path, to: v }, (r) => { if (r.map) followId(r.map.from, r.map.to); });
}
const refreshScope = (scope) => manage({ type: "refreshScope", scope });

// The Feeds tab: every feed with its health, a filter, and the same actions as the right-click menu.
const feedMatches = (f, q, prob) => (!prob || f.state !== "green" || f.disabled) && (!q || (f.title + " " + f.category).toLowerCase().includes(q));
function feedRow(f) {
  const btn = (act, text, fn) => h("button", { class: "btn small", "data-act": act, onclick: fn }, text);
  const note = f.disabled ? "Disabled: Miniflux is not fetching this feed." : f.state !== "green" ? (f.errorText || f.sentence) : "";
  return h("div", { class: "frow", "data-feed": String(f.id), "data-state": f.disabled ? "off" : f.state },
    h("span", { class: "lamp " + (f.disabled ? "off" : f.state), title: f.disabled ? "Disabled" : STATE_WORD[f.state] }),
    h("div", { class: "fmain" }, h("b", { class: "ftitle" }, f.title), h("span", { class: "fcat" }, f.category), note ? h("span", { class: "fnote" }, note) : null),
    h("div", { class: "tacts" }, btn("feed-refresh", "Refresh", () => feedAct.refresh(f.id)), btn("feed-rename", "Rename", () => feedAct.rename(f.id)), btn("feed-move", "Move", () => feedAct.move(f.id)),
      btn("feed-toggle", f.disabled ? "Enable" : "Disable", () => feedAct.toggle(f.id, f.disabled)), h("button", { class: "btn small danger", "data-act": "feed-delete", onclick: () => feedAct.remove(f.id) }, "Delete")));
}
function fillFeedList() {
  const box = $app.querySelector("[data-flist]"); if (!box) return; const all = S.feedsInfo; const sum = $app.querySelector("[data-fsum]");
  if (!all) { box.replaceChildren(h("p", { class: "note" }, "Reading your feeds.")); return; }
  const q = (S.fq || "").trim().toLowerCase(); const list = all.filter(f => feedMatches(f, q, S.fprob)).sort((a, b) => (a.category + "\u0001" + a.title).localeCompare(b.category + "\u0001" + b.title));
  const shown = list.slice(0, S.fpage * FEED_PAGE);
  const kids = shown.length ? shown.map(feedRow) : [h("p", { class: "note" }, all.length ? "No feed matches." : "No feeds yet. Add one with the plus button in the sidebar.")];
  if (list.length > shown.length) kids.push(h("button", { class: "btn", "data-act": "feeds-more", onclick: () => { S.fpage++; fillFeedList(); } }, `Show ${Math.min(FEED_PAGE, list.length - shown.length)} more`));
  box.replaceChildren(...kids);
  if (sum) { const bad = all.filter(f => f.state !== "green" || f.disabled).length; sum.textContent = `${all.length} feed${all.length === 1 ? "" : "s"}${bad ? `, ${bad} with trouble or disabled` : ""}`; }
}
function feedsMain() {
  loadFeedsInfo(); if (S.feedsInfo) queueMicrotask(fillFeedList);
  return [h("div", { class: "feedbar" },
    h("input", { type: "search", class: "fq", "data-field": "feed-filter", placeholder: "Filter by name or folder", "aria-label": "Filter feeds", value: S.fq || "", oninput: (e) => { S.fq = e.target.value; S.fpage = 1; fillFeedList(); } }),
    h("label", { class: "chk" }, h("input", { type: "checkbox", "data-field": "feed-problems", checked: S.fprob, onchange: (e) => { S.fprob = e.target.checked; S.fpage = 1; fillFeedList(); } }), "Only feeds with trouble"),
    h("button", { class: "btn small", "data-act": "refresh-all", onclick: () => refreshScope("all") }, "Refresh every feed")),
    h("p", { class: "note", "data-fsum": "1" }, ""), h("div", { class: "flist", "data-flist": "1" }, h("p", { class: "note" }, "Reading your feeds."))];
}
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
  let els = rowEls(); if (S.data && d > 0 && els.length && Number(els[els.length - 1].dataset.id) === S.selId) { const nx = S.data.groups.find(g => g.pending && !isCollapsed(g.key)); if (nx) { fillNow(nx); els = rowEls(); } }
  if (!els.length) return; let i = els.findIndex(e => Number(e.dataset.id) === S.selId); i = i < 0 ? (d > 0 ? 0 : els.length - 1) : Math.min(els.length - 1, Math.max(0, i + d));
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
  // Wide screens: with the article in the side pane, the reading keys scroll the article, not the list behind it.
  if (S.openCard && ["PageDown", "PageUp", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && window.matchMedia("(min-width: 1800px)").matches) {
    const pane = document.querySelector('.row[data-card="true"] .cardwrap');
    if (pane && getComputedStyle(pane).position === "fixed") {
      const page = pane.clientHeight * 0.85, line = 60; const dir = e.key === "PageUp" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey) ? -1 : 1;
      if (e.key === "Home") pane.scrollTo({ top: 0 }); else if (e.key === "End") pane.scrollTo({ top: pane.scrollHeight });
      else pane.scrollBy({ top: dir * (e.key.startsWith("Arrow") ? line : page) });
      e.preventDefault(); return;
    }
  }
  if (e.key === "/") { $app.querySelector(".search input")?.focus(); e.preventDefault(); return; }
  const r = S.rows.get(S.selId); const cardOpen = !!S.openCard;
  const handled = (() => {
    switch (e.key) {
      case "j": selectOffset(1, cardOpen); return true; case "k": selectOffset(-1, cardOpen); return true;
      case "o": case "Enter": if (r) openCardFor(r); return true; case "b": if (r) backgroundOpen(r); return true; case "w": if (r) fetchFull(r); return true;
      case "+": case "=": if (r) rateRow(r, 1); return true; case "-": if (r) rateRow(r, -1); return true;
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
