// Message handlers shared by the background page and the test bed. Browser-specific actions are injected.
import { Miniflux } from "./miniflux.js";
import { WebDav } from "./webdav.js";
import { Raindrop } from "./raindrop.js";
import { exportBundle, importBundle } from "./bundle.js";
import { SETTING_FIELDS } from "./profilesync.js";

// Tests the values typed into Settings (creds) before they are saved, or the saved ones when none are given.
export async function testConnection(which, creds, engine, fetchImpl) {
  const s = creds || engine.settings;
  try {
    if (which === "miniflux") {
      if (!s.miniflux.url || !s.miniflux.token) return { ok: false, sentence: "Enter the Miniflux address and API key first." };
      const me = await new Miniflux({ baseUrl: s.miniflux.url, token: s.miniflux.token, fetchImpl }).me(); return { ok: true, sentence: `Connected to Miniflux as ${me.username}.` };
    }
    if (which === "webdav") {
      const w = s.webdav; if (!w.url || !w.user || !w.pass) return { ok: false, sentence: "Enter the address, user name and app password first." };
      const dav = new WebDav({ baseUrl: w.url, user: w.user, pass: w.pass, fetchImpl }); const root = w.root || "pravaha";
      await dav.mkdirs(root); const stamp = String(Date.now()); await dav.put(`${root}/.pravaha-test`, stamp);
      if ((await dav.get(`${root}/.pravaha-test`)) !== stamp) return { ok: false, sentence: "The storage accepted a test file but returned different contents when it was read back." };
      return { ok: true, sentence: `The storage accepted the login and a test file was written to the ${root} folder.` };
    }
    if (which === "raindrop") {
      if (!s.raindrop.token) return { ok: false, sentence: "Enter the Raindrop token first." };
      const t = await new Raindrop({ token: s.raindrop.token, fetchImpl }).tags(); return { ok: true, sentence: `Raindrop answered; ${t.length} tags found.` };
    }
  } catch (e) { return { ok: false, sentence: e.plain || "The test failed for an unexpected reason." }; }
  return { ok: false, sentence: "Unknown test." };
}

// Which Firefox Sync parts a settings patch touches.
export function partsFor(patch) {
  const parts = []; if (patch.miniflux || patch.webdav || patch.raindrop) parts.push("keys");
  if (SETTING_FIELDS.some(f => patch[f] !== undefined)) parts.push("settings"); if (patch.treeOrder !== undefined) parts.push("order"); if (patch.ui !== undefined) parts.push("ui");
  return parts;
}
export function makeHandlers({ engine, fetchImpl, runSync, schedule, openTab, profile, detect, openSubscribe }) {
  const share = async (parts, opts) => { if (!profile) return null; try { return await profile.push(parts, opts); } catch { return null; } };
  return {
  boot: async () => ({ settings: engine.settings, tree: engine.tree(), status: engine.status(), rules: engine.trainingRules(), icons: engine.icons }),
  icons: async () => engine.icons,
  tree: async () => ({ tree: engine.tree(), status: engine.status(), unreadTotal: engine.unreadCount() }),
  content: (m) => engine.getContent(m.id),
  fetchFull: (m) => engine.fetchFull(m.id),
  card: (m) => engine.openCard(m.id),
  dwell: (m) => engine.recordDwell(m.id, m.feedId, m.ms),
  view: async (m) => ({ view: engine.getView(m.params), tree: engine.tree(), status: engine.status() }),
  markRead: (m) => engine.markRead(m.ids, { explicit: !!m.explicit, verify: m.verify === undefined ? undefined : !!m.verify }),
  markUnread: (m) => engine.markUnread(m.ids),
  markScope: (m) => engine.markScope(String(m.scope || "all")),
  search: async (m) => engine.search(m.q, { limit: m.limit }),
  searchServer: (m) => engine.searchServer(m.q),
  restore: (m) => engine.restore(m.id),
  categories: () => engine.categoryList(),
  discover: (m) => engine.discover(m.url),
  subscribe: (m) => engine.subscribe({ feedUrl: m.feedUrl, categoryId: m.categoryId, newCategory: m.newCategory }),
  feedDetectState: async () => (detect ? detect.state() : { granted: false, registered: false, on: false, unavailable: true }),
  feedDetectOn: async () => (detect ? detect.enable() : { ok: false, sentence: "Feed detection is not available here." }),
  feedDetectOff: async () => (detect ? detect.disable() : { ok: true }),
  feedsFor: async (m) => (detect ? detect.get(Number(m.tabId)) : []),
  openSubscribe: async (m) => { const u = String(m.url || ""); if (!openSubscribe || !/^https?:\/\//i.test(u)) return { ok: false }; await openSubscribe(u); return { ok: true }; },
  reorderFolders: async (m) => { const moved = await engine.setOrder(Array.isArray(m.ids) ? m.ids : []); if (moved) await share(["order"]); return { moved, tree: engine.tree() }; },
  moveNode: async (m) => { const moved = await engine.moveNode(m.id, m.dir === "up" ? "up" : "down"); if (moved) await share(["order"]); return { moved, tree: engine.tree() }; },
  open: async (m) => { const r = await engine.open(m.id); if (!r) return null; await openTab(r, m.id); return true; },
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
  test: (m) => testConnection(m.which, m.creds, engine, fetchImpl),
  saveSettings: async (m) => {
    await engine.saveSettings(m.patch); await schedule(); await share(partsFor(m.patch));
    runSync(); return engine.settings;
  },
  // Look-and-feel choices made in the reader (theme, fonts, density) travel with the settings.
  saveUi: async (m) => { await engine.saveSettings({ ui: m.ui && typeof m.ui === "object" ? m.ui : null }); await share(["ui"]); return true; },
  profileSync: async () => (profile ? profile.summary() : null),
  profilePull: async (m) => {
    if (!profile) return null; const r = await profile.pull({ force: !!m.force });
    if (r.applied.some(a => a.part === "keys")) runSync();
    return { ...r, summary: await profile.summary() };
  },
  profilePush: async () => { if (!profile) return null; const r = await profile.push(null, { force: true }); return { ...r, summary: await profile.summary() }; },
  exportSettings: async (m) => {
    try { const o = await exportBundle(engine, { keys: !!m.keys, passphrase: m.passphrase || "", history: !!m.history, ui: m.ui || null }); const day = new Date(engine.now()).toISOString().slice(0, 10); return { ok: true, filename: `pravaha-settings-${day}.json`, text: JSON.stringify(o, null, 1), keys: !!o.keys, events: (o.events || []).length }; }
    catch (e) { return { ok: false, sentence: e.plain || "The settings file could not be made." }; }
  },
  importSettings: async (m) => {
    try {
      const r = await importBundle(engine, String(m.text || ""), { passphrase: m.passphrase || "" });
      await schedule(); await share(null, { force: true }); runSync();
      return { ok: true, ...r, settings: engine.settings };
    } catch (e) { return { ok: false, code: e.code || "error", sentence: e.plain || "The file could not be imported." }; }
  }
  };
}
