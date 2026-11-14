// Miniflux REST client. Auth is the X-Auth-Token header (Settings > API Keys in Miniflux).
import { PlainError } from "./webdav.js";

export const DEAD_FEED_ERRORS = 5;
export function splitCategory(title) { return String(title || "Uncategorised").split("/").map(s => s.trim()).filter(Boolean); }

export class Miniflux {
  constructor({ baseUrl, token, fetchImpl }) {
    this.base = String(baseUrl || "").replace(/\/+$/, "");
    this.token = token; this.fetch = fetchImpl || ((...a) => fetch(...a));
  }
  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${this.base}/v1${path}`, {
        method, headers: { "X-Auth-Token": this.token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new PlainError("Could not reach Miniflux. Check the connection or the server address; the reader will use the copy saved on this machine.", "unreachable");
    }
    if (res.status === 401 || res.status === 403) throw new PlainError("Miniflux refused the API key. Create a new key in Miniflux under Settings, then API Keys, and enter it in Settings here.", "auth");
    if (res.status === 204) return null;
    if (!res.ok) {
      let msg = ""; try { const j = JSON.parse(await res.text()); msg = String((j && j.error_message) || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 200); } catch { /* no body */ }
      if (msg && res.status < 600) throw new PlainError(`Miniflux said: ${msg}`, "rejected");
      throw new PlainError(`Miniflux answered with an unexpected reply (${res.status}). Try again in a minute.`, "bad-reply");
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  me() { return this.call("GET", "/me"); }
  feeds() { return this.call("GET", "/feeds"); }
  categories() { return this.call("GET", "/categories"); }
  feedIcon(id) { return this.call("GET", `/feeds/${id}/icon`); }
  counters() { return this.call("GET", "/feeds/counters"); }
  entries(params = {}) {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    return this.call("GET", "/entries" + (q.toString() ? "?" + q : ""));
  }
  entry(id) { return this.call("GET", `/entries/${id}`); }
  fetchContent(id) { return this.call("GET", `/entries/${id}/fetch-content`); }
  setStatus(ids, status) { return this.call("PUT", "/entries", { entry_ids: ids, status }); }
  toggleBookmark(id) { return this.call("PUT", `/entries/${id}/bookmark`); }
  discover(url) { return this.call("POST", "/discover", { url }); }
  createFeed({ feed_url, category_id }) { return this.call("POST", "/feeds", { feed_url, category_id }); }
  createCategory(title) { return this.call("POST", "/categories", { title }); }
  markFeedRead(feedId) { return this.call("PUT", `/feeds/${feedId}/mark-all-as-read`); }
  refreshAll() { return this.call("PUT", "/feeds/refresh"); }
  async allUnread(cap = 3000) {
    const out = []; let offset = 0; const limit = 250;
    for (;;) {
      const r = await this.entries({ status: "unread", limit, offset, order: "published_at", direction: "desc" });
      out.push(...(r.entries || [])); offset += limit;
      if (!r.entries || r.entries.length < limit || out.length >= cap) return { total: r.total, entries: out };
    }
  }
  async changedSince(unixSeconds, cap = 1000) {
    const r = await this.entries({ changed_after: unixSeconds, limit: cap, order: "id", direction: "asc" });
    return r.entries || [];
  }
}

export function feedHealth(feed, now = Date.now()) {
  const errs = feed.parsing_error_count || 0;
  const checked = feed.checked_at ? Date.parse(feed.checked_at) : null;
  const staleDays = checked ? (now - checked) / 86400000 : null;
  let state = "green"; let sentence = "Fetching normally.";
  if (feed.disabled) { state = "red"; sentence = "This feed is disabled in Miniflux."; }
  else if (errs >= DEAD_FEED_ERRORS) { state = "red"; sentence = `Miniflux has failed to read this feed ${errs} times in a row${feed.parsing_error_message ? ` (${feed.parsing_error_message})` : ""}. It is excluded from ranking until it recovers.`; }
  else if (errs > 0) { state = "amber"; sentence = `Miniflux had trouble reading this feed ${errs} time${errs > 1 ? "s" : ""}; it may recover by itself.`; }
  else if (staleDays !== null && staleDays > 3) { state = "amber"; sentence = `Miniflux has not checked this feed for ${Math.floor(staleDays)} days.`; }
  return { state, sentence, dead: errs >= DEAD_FEED_ERRORS || !!feed.disabled };
}
