import { Engine } from "./src/engine.js";
import { DwellTracker } from "./src/dwell.js";
import { makeHandlers } from "./src/handlers.js";
import { ProfileSync } from "./src/profilesync.js";
import { FeedDetect } from "./src/feeddetect.js";

const storage = { get: (k) => browser.storage.local.get(k), set: (o) => browser.storage.local.set(o) };
const dwell = new DwellTracker();
let syncing = 0; let rerun = false; // the time the running sync started, or 0
// With no reader tab open nobody is looking, so a poll runs at most every ten minutes; the toolbar mark still updates.
const IDLE_POLL_MS = 10 * 60000;
async function readerOpen() {
  try { if (browser.extension && browser.extension.getViews) return browser.extension.getViews({ type: "tab" }).some(w => w.location.pathname.endsWith("/ui/reader.html")); } catch { /* fall through */ }
  return (await browser.tabs.query({ url: browser.runtime.getURL("ui/reader.html") })).length > 0;
}

function flattenBookmarks(nodes, out = []) {
  for (const n of nodes) { if (n.url) out.push({ title: n.title, url: n.url, visits: 1 }); if (n.children) flattenBookmarks(n.children, out); }
  return out;
}
const platform = {
  async echoDocs(days) {
    const docs = flattenBookmarks(await browser.bookmarks.getTree());
    const hist = await browser.history.search({ text: "", startTime: Date.now() - days * 86400000, maxResults: 5000 });
    for (const h of hist) docs.push({ title: h.title || "", url: h.url, visits: h.visitCount || 1 });
    return docs;
  }
};
let badgeTimer = null, badgeKey = "";
const engine = new Engine({ storage, platform, onChange: () => { browser.runtime.sendMessage({ type: "changed" }).catch(() => {}); badgeSoon(); } });

// The toolbar button wears a small mark when something needs attention, so a quiet server change or a failing connection is seen without opening the reader.
// Red "!" means Miniflux or the WebDAV storage cannot be reached, or the server contract is broken; amber "!" means Miniflux changed or lacks a feature. A page with feeds still shows its own count.
function badgeSoon() { if (badgeTimer) return; badgeTimer = setTimeout(() => { badgeTimer = null; updateBadge().catch(() => {}); }, 1500); }
async function updateBadge() {
  const a = browser.action; if (!a || !a.setBadgeText) return;
  const st = engine.status(); const lamp = st.lights.find(x => x.id === "server"); const sv = lamp && lamp.state;
  const down = st.lights.some(x => (x.id === "miniflux" || x.id === "webdav") && x.state === "red");
  const state = down || sv === "red" ? "red" : sv === "amber" ? "amber" : "";
  const title = state ? (sv === "red" || sv === "amber" ? lamp.sentence.split(". ")[0] + "." : "A connection is down. Open the Sync page.") : "";
  const key = state + "|" + title; if (key === badgeKey) return; badgeKey = key;
  await a.setBadgeText({ text: state ? "!" : "" });
  if (state) { await a.setBadgeBackgroundColor({ color: state === "red" ? "#b3261e" : "#b26a00" }); if (a.setBadgeTextColor) await a.setBadgeTextColor({ color: "#ffffff" }); }
  if (a.setTitle) await a.setTitle({ title: state ? "Pravaha: " + title : null });
}

// Firefox Sync carries keys, settings and look between machines. A new machine takes them without being asked.
const profile = new ProfileSync({
  engine, area: browser.storage.sync,
  onApplied: (applied) => { browser.runtime.sendMessage({ type: "profile", applied }).catch(() => {}); if (applied.some(a => a.part === "keys")) runSync(); }
});
const ready = (async () => {
  await engine.load();
  try {
    // 0.3.x kept only the keys, in one item, and only when a box was ticked. Take them if this machine has none.
    const legacy = (await browser.storage.sync.get("pravahaCreds")).pravahaCreds;
    if (legacy && legacy.miniflux && !engine.settings.miniflux.token) await engine.saveSettings({ miniflux: legacy.miniflux, webdav: legacy.webdav || {}, raindrop: legacy.raindrop || {} });
  } catch { /* Firefox Sync storage is optional */ }
  try { await profile.reconcile(); } catch { /* the reader shows the problem on the Sync page */ }
  try { dwell.restore((await browser.storage.session.get("dwell")).dwell); } catch { /* session storage may be absent */ }
  await schedule();
})();

// The alarm survives the background page being unloaded, so a wake leaves it alone; only a changed interval (or no alarm) re-arms it.
// (Re-arming on every wake used to add an extra poll twelve seconds after each wake.)
async function schedule() {
  const period = Math.max(1, engine.settings.pollMinutes || 2); const cur = await browser.alarms.get("poll").catch(() => null);
  if (cur && cur.periodInMinutes === period) return;
  await browser.alarms.clear("poll");
  browser.alarms.create("poll", { delayInMinutes: 0.2, periodInMinutes: period });
}
async function saveDwell() { try { await browser.storage.session.set({ dwell: dwell.snapshot() }); } catch { /* ignore */ } }
async function runSync(opts) {
  // Every request has a deadline, so a sync cannot hang; the five-minute guard is a second line of defence.
  if (syncing && Date.now() - syncing < 5 * 60000) { if (!(opts && opts.quiet)) rerun = true; return; } // a sync you asked for during a running one runs right after it
  syncing = Date.now();
  try { await engine.syncNow(opts); try { if (browser.storage.local.getBytesInUse) engine.bytesInUse = await browser.storage.local.getBytesInUse(null); } catch { /* not in every Firefox */ } } finally { syncing = 0; if (rerun) { rerun = false; runSync(); } }
}

// Firefox may not wake this page when Sync delivers data, so every poll also looks at Firefox Sync's storage (a local read, no network).
browser.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "poll") return; await ready;
  try { await profile.pull(); } catch { /* shown on the Move setup tab */ }
  const last = (engine.net.miniflux && engine.net.miniflux.lastOkAt) || 0;
  if (!(await readerOpen().catch(() => true)) && Date.now() - last < IDLE_POLL_MS && !engine.pendingOps.length) return;
  await runSync({ quiet: true });
});
// Firefox unloads this page when it is idle; the heavy keys waiting for their short delay are written first.
if (browser.runtime.onSuspend) browser.runtime.onSuspend.addListener(() => { engine.sendHeld().catch(() => {}); engine.flushPersist().catch(() => {}); });
browser.runtime.onInstalled.addListener(async () => { await ready; await schedule(); });
browser.runtime.onStartup.addListener(async () => { await ready; await runSync(); });
ready.then(badgeSoon).catch(() => {});
browser.action.onClicked.addListener(async () => {
  const url = browser.runtime.getURL("ui/reader.html");
  const tabs = await browser.tabs.query({ url });
  if (tabs.length) { await browser.tabs.update(tabs[0].id, { active: true }); await browser.windows.update(tabs[0].windowId, { focused: true }); }
  else await browser.tabs.create({ url });
});

// Right-click on a page or a link: open the reader's Add feed dialog with that address filled in.
function openSubscribe(target) {
  const base = browser.runtime.getURL("ui/reader.html");
  return browser.tabs.query({ url: base }).then(async (tabs) => {
    const url = base + "#subscribe=" + encodeURIComponent(target);
    if (tabs.length) { await browser.tabs.update(tabs[0].id, { url, active: true }); await browser.windows.update(tabs[0].windowId, { focused: true }); }
    else await browser.tabs.create({ url });
  });
}
browser.runtime.onInstalled.addListener(() => {
  browser.menus.removeAll().then(() => browser.menus.create({ id: "pravaha-find-feeds", title: "Subscribe with Pravaha", contexts: ["page", "link"] }));
});
browser.menus.onClicked.addListener((info) => {
  const target = info.linkUrl || info.pageUrl; if (info.menuItemId === "pravaha-find-feeds" && /^https?:/i.test(target || "")) openSubscribe(target);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => { await ready; dwell.setActive(tabId, Date.now()); await saveDwell(); });
browser.windows.onFocusChanged.addListener(async (winId) => {
  await ready;
  if (winId === browser.windows.WINDOW_ID_NONE) dwell.blur(Date.now());
  else { const [t] = await browser.tabs.query({ active: true, windowId: winId }); if (t) dwell.setActive(t.id, Date.now()); }
  await saveDwell();
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  await ready; const r = dwell.close(tabId, Date.now()); await saveDwell();
  if (r) await engine.recordDwell(r.meta.id, r.meta.feedId, r.ms);
});

const detect = new FeedDetect(browser);
browser.tabs.onUpdated.addListener((tabId, info) => { if (info.status === "loading" || info.url) detect.clear(tabId); });
browser.tabs.onRemoved.addListener((tabId) => detect.clear(tabId));
browser.permissions.onRemoved.addListener(() => { detect.sync().catch(() => {}); });
browser.runtime.onStartup.addListener(() => { detect.sync().catch(() => {}); });
const handlers = makeHandlers({
  engine, runSync, schedule,
  openTab: async (r, id) => { const tab = await browser.tabs.create({ url: r.url, active: false }); dwell.track(tab.id, { id, feedId: r.feedId }, Date.now(), false); await saveDwell(); },
  profile, detect, openSubscribe
});
// Something arrived through Firefox Sync from another machine: take it if it is newer.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && Object.keys(changes).some(k => k.startsWith("pv:"))) ready.then(() => profile.pull()).catch(() => {});
});
browser.runtime.onMessage.addListener((m, sender) => {
  if (m && m.type === "feedsFound") return detect.found(sender, m);
  if (!m || !handlers[m.type]) return;
  return ready.then(() => handlers[m.type](m));
});
