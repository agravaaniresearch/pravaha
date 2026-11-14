import { Engine } from "./src/engine.js";
import { DwellTracker } from "./src/dwell.js";
import { Miniflux } from "./src/miniflux.js";
import { WebDav } from "./src/webdav.js";
import { Raindrop } from "./src/raindrop.js";

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

const ready = (async () => {
  await engine.load();
  // Optional: credentials carried by Firefox Sync (end-to-end encrypted) when the user has switched that on.
  try {
    const s = (await browser.storage.sync.get("pravahaCreds")).pravahaCreds;
    if (s && engine.settings.syncCreds && !engine.settings.miniflux.token) await engine.saveSettings({ miniflux: s.miniflux, webdav: s.webdav, raindrop: s.raindrop });
  } catch { /* Firefox Sync storage is optional */ }
  try { dwell.restore((await browser.storage.session.get("dwell")).dwell); } catch { /* session storage may be absent */ }
  await schedule();
})();

async function schedule() {
  await browser.alarms.clear("poll");
  browser.alarms.create("poll", { delayInMinutes: 0.2, periodInMinutes: Math.max(1, engine.settings.pollMinutes || 2) });
}
async function saveDwell() { try { await browser.storage.session.set({ dwell: dwell.snapshot() }); } catch { /* ignore */ } }
async function runSync() {
  if (syncing) return; syncing = true;
  try { await engine.syncNow(); } finally { syncing = false; }
}

browser.alarms.onAlarm.addListener(async (a) => { if (a.name === "poll") { await ready; await runSync(); } });
browser.runtime.onInstalled.addListener(async () => { await ready; await schedule(); });
browser.runtime.onStartup.addListener(async () => { await ready; await runSync(); });
browser.action.onClicked.addListener(async () => {
  const url = browser.runtime.getURL("ui/reader.html");
  const tabs = await browser.tabs.query({ url });
  if (tabs.length) { await browser.tabs.update(tabs[0].id, { active: true }); await browser.windows.update(tabs[0].windowId, { focused: true }); }
  else await browser.tabs.create({ url });
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

async function testConnection(which) {
  const s = engine.settings;
  try {
    if (which === "miniflux") { const me = await new Miniflux({ baseUrl: s.miniflux.url, token: s.miniflux.token }).me(); return { ok: true, sentence: `Connected to Miniflux as ${me.username}.` }; }
    if (which === "webdav") { await new WebDav({ baseUrl: s.webdav.url, user: s.webdav.user, pass: s.webdav.pass }).list(s.webdav.root || "pravaha"); return { ok: true, sentence: "The WebDAV storage answered and accepted the login." }; }
    if (which === "raindrop") { const t = await new Raindrop({ token: s.raindrop.token }).tags(); return { ok: true, sentence: `Raindrop answered; ${t.length} tags found.` }; }
  } catch (e) { return { ok: false, sentence: e.plain || "The test failed for an unexpected reason." }; }
  return { ok: false, sentence: "Unknown test." };
}

const handlers = {
  boot: async () => ({ settings: engine.settings, tree: engine.tree(), status: engine.status(), rules: engine.trainingRules() }),
  view: async (m) => ({ view: engine.getView(m.params), tree: engine.tree(), status: engine.status() }),
  markRead: (m) => engine.markRead(m.ids, { explicit: !!m.explicit }),
  markUnread: (m) => engine.markUnread(m.ids),
  open: async (m) => {
    const r = await engine.open(m.id); if (!r) return null;
    const tab = await browser.tabs.create({ url: r.url, active: false });
    dwell.track(tab.id, { id: m.id, feedId: r.feedId }, Date.now(), false); await saveDwell(); return true;
  },
  save: (m) => engine.toggleSave(m.id),
  dismiss: (m) => engine.dismiss(m.id),
  undismissAll: () => engine.undismissAll(),
  train: (m) => engine.train(m.kind, m.key, m.value),
  rules: async () => engine.trainingRules(),
  suggestTags: async (m) => engine.suggestTagsFor(m.id),
  syncNow: async () => { await runSync(); return engine.status(); },
  status: async () => engine.status(),
  stats: async () => engine.stats(),
  digest: async () => { try { const r = await engine.writeDigest(); return { ok: true, sentence: `Wrote the digest for ${r.week} to the WebDAV folder.` }; } catch (e) { return { ok: false, sentence: e.plain || "The digest could not be written." }; } },
  test: (m) => testConnection(m.which),
  saveSettings: async (m) => {
    await engine.saveSettings(m.patch); await schedule();
    try {
      const s = engine.settings;
      if (s.syncCreds) await browser.storage.sync.set({ pravahaCreds: { miniflux: s.miniflux, webdav: s.webdav, raindrop: s.raindrop } });
      else await browser.storage.sync.remove("pravahaCreds");
    } catch { /* ignore */ }
    runSync(); return engine.settings;
  }
};
browser.runtime.onMessage.addListener((m) => {
  if (!m || !handlers[m.type]) return;
  return ready.then(() => handlers[m.type](m));
});
