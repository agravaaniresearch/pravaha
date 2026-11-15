// Carries this machine's keys, settings and look to the other machines through Firefox Sync's extension storage
// (browser.storage.sync, which Firefox encrypts end to end). Reading history and training do NOT travel here;
// they use the WebDAV event log. Each part is a separate item so one oversized part cannot block the others.
//
//   pv:keys      Miniflux, WebDAV and Raindrop addresses and keys
//   pv:settings  weights, poll interval, retention, palette and the other plain settings
//   pv:order     the folder order set with the up and down arrows
//   pv:ui        theme, fonts, density and the other look-and-feel choices
//
// Every item is { v: 1, at: <ms>, by: <machine name>, data }. The newest "at" wins, per part. A machine that has
// never been set up never pushes anything, so a fresh install cannot overwrite what is waiting for it.
export const PARTS = ["keys", "settings", "order", "ui"];
export const SETTING_FIELDS = ["weights", "pollMinutes", "novelty", "palette", "theme", "retentionDays", "autoTag", "autoDigest", "saveToRaindrop", "searchKeepDays"];
export const ITEM_LIMIT = 7600; // Firefox allows 8192 bytes per item, counting the key and quoting

const key = (p) => `pv:${p}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function partData(settings, part) {
  if (part === "keys") return { miniflux: { url: settings.miniflux.url, token: settings.miniflux.token }, webdav: { url: settings.webdav.url, user: settings.webdav.user, pass: settings.webdav.pass, root: settings.webdav.root }, raindrop: { token: settings.raindrop.token } };
  if (part === "settings") { const o = {}; for (const f of SETTING_FIELDS) if (settings[f] !== undefined) o[f] = settings[f]; return clone(o); }
  if (part === "order") return clone(settings.treeOrder || {});
  if (part === "ui") return settings.ui ? clone(settings.ui) : null;
  return null;
}
export const hasKeys = (settings) => !!(settings.miniflux.token || settings.webdav.pass || settings.raindrop.token);
export const toggleOf = (settings, part) => (part === "keys" ? settings.sync.keys : settings.sync.settings) !== false;

// Turns a part from Firefox Sync into a patch for engine.saveSettings. Unknown or malformed data is ignored.
export function patchFor(part, data) {
  if (!data || typeof data !== "object") return null;
  if (part === "keys") {
    const p = {};
    if (data.miniflux && typeof data.miniflux === "object") p.miniflux = { url: String(data.miniflux.url || ""), token: String(data.miniflux.token || "") };
    if (data.webdav && typeof data.webdav === "object") p.webdav = { url: String(data.webdav.url || ""), user: String(data.webdav.user || ""), pass: String(data.webdav.pass || ""), root: String(data.webdav.root || "pravaha") };
    if (data.raindrop && typeof data.raindrop === "object") p.raindrop = { token: String(data.raindrop.token || "") };
    return Object.keys(p).length ? p : null;
  }
  if (part === "settings") { const p = {}; for (const f of SETTING_FIELDS) if (data[f] !== undefined) p[f] = data[f]; return Object.keys(p).length ? p : null; }
  if (part === "order") return { treeOrder: data };
  if (part === "ui") return { ui: data };
  return null;
}

export class ProfileSync {
  constructor({ engine, area, now = () => Date.now(), onApplied = () => {} }) { this.engine = engine; this.area = area; this.now = now; this.onApplied = onApplied; this.lastError = null; this.lastApplied = []; this.lastPulledAt = null; }
  get s() { return this.engine.settings; }
  _meta(part) { return (this.s.syncMeta && this.s.syncMeta[part]) || { at: 0, hash: "" }; }
  async _remote() {
    const raw = await this.area.get(PARTS.map(key)); const out = {};
    for (const p of PARTS) { const v = raw && raw[key(p)]; if (v && typeof v === "object" && v.v === 1 && Number(v.at) > 0) out[p] = v; }
    return out;
  }
  async _setMeta(part, at, hash) { await this.engine.saveSettings({ syncMeta: { [part]: { at, hash } } }); }

  // Newer remote parts replace the local ones. force=true takes every remote part whatever its age (the "Fetch now" button).
  async pull({ force = false } = {}) {
    this.lastError = null; const applied = [];
    let remote; try { remote = await this._remote(); } catch (e) { this.lastError = "Firefox Sync storage could not be read on this machine."; return { applied, found: {}, error: this.lastError }; }
    for (const part of PARTS) {
      const r = remote[part]; if (!r || !toggleOf(this.s, part)) continue;
      if (!force && r.at <= this._meta(part).at) continue;
      const patch = patchFor(part, r.data); if (!patch) continue;
      if (part === "keys" && JSON.stringify(partData(this.s, "keys")) === JSON.stringify(r.data) && !force) { await this._setMeta(part, r.at, JSON.stringify(r.data)); continue; }
      await this.engine.saveSettings(patch); await this._setMeta(part, r.at, JSON.stringify(r.data));
      applied.push({ part, by: r.by, at: r.at });
    }
    this.lastPulledAt = this.now(); if (applied.length) { this.lastApplied = applied; this.onApplied(applied); }
    return { applied, found: Object.fromEntries(Object.entries(remote).map(([p, v]) => [p, { at: v.at, by: v.by }])) };
  }

  // Writes the named parts, or with no names the parts that differ from what was last sent. Never sends keys that are empty.
  async push(parts = null, { force = false } = {}) {
    this.lastError = null; const sent = []; const skipped = [];
    // A machine with no keys has nothing worth sharing, and writing its defaults could overwrite a good setup waiting in Firefox Sync.
    if (!hasKeys(this.s)) return { sent, skipped, idle: true };
    for (const part of parts || PARTS) {
      if (!toggleOf(this.s, part)) continue;
      if (part === "keys" && !hasKeys(this.s)) continue;
      const data = partData(this.s, part); if (data === null) continue;
      if (part === "order" && !Object.keys(data).length && !force) continue;
      const hash = JSON.stringify(data); if (!force && hash === this._meta(part).hash) continue;
      const at = Math.max(this.now(), this._meta(part).at + 1);
      const item = { v: 1, at, by: this.s.device, data };
      if (JSON.stringify({ [key(part)]: item }).length > ITEM_LIMIT) { skipped.push(part); continue; }
      try { await this.area.set({ [key(part)]: item }); } catch (e) { this.lastError = "Firefox Sync storage refused the write: " + String(e && e.message || e).slice(0, 120); return { sent, skipped, error: this.lastError }; }
      await this._setMeta(part, at, hash); sent.push(part);
    }
    if (skipped.length) this.lastError = `${skipped.join(" and ")} is too large for Firefox Sync's limit and was kept on this machine only.`;
    return { sent, skipped };
  }

  // At start-up: take what is newer from Firefox Sync, then offer what this established machine has that Firefox Sync lacks.
  async reconcile() {
    const pulled = await this.pull(); let seeded = null;
    if (hasKeys(this.s)) {
      const need = PARTS.filter(p => !pulled.found[p]);
      if (need.length) seeded = await this.push(need);
    }
    return { ...pulled, seeded };
  }

  async summary() {
    let remote = {}; let readable = true; try { remote = await this._remote(); } catch { readable = false; }
    return {
      readable, device: this.s.device, error: this.lastError, lastPulledAt: this.lastPulledAt, lastApplied: this.lastApplied,
      keys: { on: toggleOf(this.s, "keys") }, settings: { on: toggleOf(this.s, "settings") },
      parts: PARTS.map(p => { const r = remote[p]; const m = this._meta(p); return { part: p, remote: r ? { at: r.at, by: r.by } : null, local: m.at || null, state: !r ? "absent" : r.at > m.at ? "remote-newer" : r.at < m.at ? "local-newer" : "level" }; })
    };
  }
}
