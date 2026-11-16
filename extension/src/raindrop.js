// Raindrop client: read your tags and notes to build the centroid; optional one-way save.
import { PlainError, deadline, timedOut } from "./webdav.js";
import { domainOf } from "./text.js";

export class Raindrop {
  constructor({ token, fetchImpl }) { this.token = token; this.fetch = fetchImpl || ((...a) => fetch(...a)); }
  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch("https://api.raindrop.io/rest/v1" + path, { method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: deadline() });
    } catch (e) {
      if (timedOut(e)) throw new PlainError("Raindrop did not answer in time. Tag matching uses the copy saved on this machine.", "timeout"); throw new PlainError("Could not reach Raindrop. Tag matching will use the copy saved on this machine.", "unreachable"); }
    if (res.status === 401) throw new PlainError("Raindrop refused the token. Create a new test token at Raindrop's developer settings and enter it in Settings.", "auth");
    if (res.status === 429) throw new PlainError("Raindrop is limiting requests for a minute. The copy saved on this machine is used meanwhile.", "rate-limit");
    if (!res.ok) throw new PlainError(`Raindrop answered with an unexpected reply (${res.status}).`, "bad-reply");
    return await res.json();
  }
  async tags() { const r = await this.call("GET", "/tags/0"); return (r.items || []).map(t => ({ tag: t._id, count: t.count })); }
  async bookmarks(maxPages = 40) {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const r = await this.call("GET", `/raindrops/0?perpage=50&page=${page}`);
      const items = r.items || []; out.push(...items.map(i => ({ id: i._id, coll: i.collection && i.collection.$id, title: i.title || "", excerpt: i.excerpt || "", note: i.note || "", tags: i.tags || [], domain: i.domain || domainOf(i.link), link: i.link, at: Date.parse(i.lastUpdate || i.created) || 0 })));
      if (items.length < 50) break;
    }
    return out;
  }
  // Every collection, top level and nested, as [{ id, title }].
  async collections() {
    const out = [];
    for (const p of ["/collections", "/collections/childrens"]) { const r = await this.call("GET", p); for (const c of r.items || []) out.push({ id: c._id, title: c.title || "" }); }
    return out;
  }
  // collection: a Raindrop collection id; without one Raindrop files the bookmark in Unsorted.
  async save({ link, title, tags, collection }) { return this.call("POST", "/raindrop", { link, title, tags, pleaseParse: {}, ...(collection ? { collection: { $id: collection } } : {}) }); }
}
