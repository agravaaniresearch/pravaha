// Raindrop client: read your tags and notes to build the centroid; optional one-way save.
import { PlainError } from "./webdav.js";
import { domainOf } from "./text.js";

export class Raindrop {
  constructor({ token, fetchImpl }) { this.token = token; this.fetch = fetchImpl || ((...a) => fetch(...a)); }
  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch("https://api.raindrop.io/rest/v1" + path, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new PlainError("Could not reach Raindrop. Tag matching will use the copy saved on this machine.", "unreachable"); }
    if (res.status === 401) throw new PlainError("Raindrop refused the token. Create a new test token at Raindrop's developer settings and enter it in Settings.", "auth");
    if (!res.ok) throw new PlainError(`Raindrop answered with an unexpected reply (${res.status}).`, "bad-reply");
    return await res.json();
  }
  async tags() { const r = await this.call("GET", "/tags/0"); return (r.items || []).map(t => ({ tag: t._id, count: t.count })); }
  async bookmarks(maxPages = 40) {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const r = await this.call("GET", `/raindrops/0?perpage=50&page=${page}`);
      const items = r.items || []; out.push(...items.map(i => ({ id: i._id, title: i.title || "", excerpt: i.excerpt || "", note: i.note || "", tags: i.tags || [], domain: i.domain || domainOf(i.link), link: i.link, at: Date.parse(i.lastUpdate || i.created) || 0 })));
      if (items.length < 50) break;
    }
    return out;
  }
  async save({ link, title, tags }) { return this.call("POST", "/raindrop", { link, title, tags, pleaseParse: {} }); }
}
