// Feed detection in the background page: remembers which tabs announced feeds, colours the toolbar icon, and registers the page
// script only while the all-sites permission is held. The browser API is injected so the logic can be tested without Firefox.
export const MATCHES = ["https://*/*", "http://*/*"];
export const SCRIPT_ID = "pravaha-feeds";
const TYPES = new Set(["rss", "atom", "json"]);
const ICON = { 16: "icons/icon-feed-16.png", 32: "icons/icon-feed-32.png" };

// Whatever a page script sends is checked again here: at most 8 feeds, http(s) addresses, short text.
export function cleanFeeds(list) {
  const out = []; if (!Array.isArray(list)) return out;
  for (const f of list) {
    if (!f || typeof f.url !== "string") continue; let u; try { u = new URL(f.url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || out.some(x => x.url === u.href)) continue;
    out.push({ url: u.href, title: typeof f.title === "string" ? f.title.slice(0, 120) : "", type: TYPES.has(f.type) ? f.type : "rss" }); if (out.length >= 8) break;
  }
  return out;
}

export class FeedDetect {
  constructor(api) { this.api = api; this.tabs = new Map(); }
  async _load() { try { const r = await this.api.storage.session.get("detected"); for (const [k, v] of Object.entries(r.detected || {})) if (!this.tabs.has(Number(k))) this.tabs.set(Number(k), v); } catch { /* session storage may be absent */ } }
  async _save() { try { await this.api.storage.session.set({ detected: Object.fromEntries(this.tabs) }); } catch { /* ignore */ } }
  // A page script reported feeds. Only messages from a tab of this extension's own script count.
  async found(sender, msg) {
    const tab = sender && sender.tab; if (!tab || typeof tab.id !== "number" || (sender.id && sender.id !== this.api.runtime.id)) return { ok: false };
    const feeds = cleanFeeds(msg && msg.feeds); if (!feeds.length) return { ok: false };
    await this._load(); this.tabs.set(tab.id, { url: tab.url || "", feeds }); await this._save();
    const n = feeds.length; const a = this.api.action;
    try {
      await a.setIcon({ tabId: tab.id, path: ICON }); await a.setBadgeText({ tabId: tab.id, text: String(n) }); await a.setBadgeBackgroundColor({ tabId: tab.id, color: "#3b2a10" });
      if (a.setBadgeTextColor) await a.setBadgeTextColor({ tabId: tab.id, color: "#ffffff" });
      await a.setTitle({ tabId: tab.id, title: `Subscribe with Pravaha (${n} ${n === 1 ? "feed" : "feeds"} found on this page)` }); await a.setPopup({ tabId: tab.id, popup: "ui/popup.html" });
    } catch { /* the tab closed */ }
    return { ok: true, count: n };
  }
  async clear(tabId) {
    await this._load(); if (!this.tabs.delete(tabId)) return; await this._save();
    const a = this.api.action; try { await a.setIcon({ tabId, path: null }); await a.setBadgeText({ tabId, text: null }); await a.setTitle({ tabId, title: null }); await a.setPopup({ tabId, popup: null }); } catch { /* the tab closed */ }
  }
  async get(tabId) { await this._load(); const t = this.tabs.get(tabId); return t ? t.feeds : []; }
  async state() {
    let granted = false, registered = false;
    try { granted = await this.api.permissions.contains({ origins: MATCHES }); } catch { /* ignore */ }
    try { registered = (await this.api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] })).length > 0; } catch { /* ignore */ }
    return { granted, registered, on: granted && registered };
  }
  // Called after the reader page has asked Firefox for the permission and been granted it.
  async enable() {
    const s = await this.state(); if (!s.granted) return { ...s, ok: false, sentence: "Firefox did not grant the permission, so feed detection stays off." };
    if (!s.registered) await this.api.scripting.registerContentScripts([{ id: SCRIPT_ID, js: ["content/detect.js"], matches: MATCHES, runAt: "document_idle", persistAcrossSessions: true, allFrames: false }]);
    return { ...(await this.state()), ok: true, sentence: "Feed detection is on." };
  }
  async disable() {
    try { await this.api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch { /* not registered */ }
    try { await this.api.permissions.remove({ origins: MATCHES }); } catch { /* ignore */ }
    this.tabs.clear(); await this._save(); return { ...(await this.state()), ok: true, sentence: "Feed detection is off." };
  }
  // The person withdrew the permission in Firefox's own settings: stop the script too.
  async sync() { const s = await this.state(); if (!s.granted && s.registered) await this.disable(); return this.state(); }
}
