import { Engine } from "./src/engine.js";
import { DwellTracker } from "./src/dwell.js";
import { makeHandlers } from "./src/handlers.js";
import { ProfileSync } from "./src/profilesync.js";
import { FeedDetect } from "./src/feeddetect.js";

const storage = { get: (k) => browser.storage.local.get(k), set: (o) => browser.storage.local.set(o) };
const dwell = new DwellTracker();
let syncing = false;

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
const engine = new Engine({ storage, platform, onChange: () => browser.runtime.sendMessage({ type: "changed" }).catch(() => {}) });

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

async function schedule() {
  await browser.alarms.clear("poll");
  browser.alarms.create("poll", { delayInMinutes: 0.2, periodInMinutes: Math.max(1, engine.settings.pollMinutes || 2) });
}
async function saveDwell() { try { await browser.storage.session.set({ dwell: dwell.snapshot() }); } catch { /* ignore */ } }
async function runSync(opts) {
  if (syncing) return; syncing = true;
  try { await engine.syncNow(opts); } finally { syncing = false; }
}

// Firefox may not wake this page when Sync delivers data, so every poll also looks at Firefox Sync's storage (a local read, no network).
browser.alarms.onAlarm.addListener(async (a) => { if (a.name === "poll") { await ready; try { await profile.pull(); } catch { /* shown on the Move setup tab */ } await runSync({ quiet: true }); } });
browser.runtime.onInstalled.addListener(async () => { await ready; await schedule(); });
browser.runtime.onStartup.addListener(async () => { await ready; await runSync(); });
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
