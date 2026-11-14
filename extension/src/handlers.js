// Message handlers shared by the background page and the test bed. Browser-specific actions are injected.
import { Miniflux } from "./miniflux.js";
import { WebDav } from "./webdav.js";
import { Raindrop } from "./raindrop.js";

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

export function makeHandlers({ engine, fetchImpl, runSync, schedule, openTab, saveSynced }) {
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
  moveNode: async (m) => ({ moved: await engine.moveNode(m.id, m.dir === "up" ? "up" : "down"), tree: engine.tree() }),
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
    await engine.saveSettings(m.patch); await schedule(); await saveSynced(engine.settings);
    runSync(); return engine.settings;
  }
  };
}
