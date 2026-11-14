import { Engine, MemoryStorage } from "../extension/src/engine.js";
// Shared fakes: an in-memory WebDAV server, Miniflux and Raindrop, all behind one fetch function.
export function makeDav({ faults = () => null } = {}) {
  const files = new Map(); const dirs = new Set([""]);
  const norm = (u) => decodeURIComponent(new URL(u).pathname).replace(/^\/+|\/+$/g, "");
  const handler = async (url, opts = {}) => {
    const f = faults(opts.method, url); if (f === "throw") throw new TypeError("network down"); if (typeof f === "number") return new Response("", { status: f });
    const p = norm(url); const m = opts.method;
    if (m === "MKCOL") { if (dirs.has(p)) return new Response("", { status: 405 }); dirs.add(p); return new Response("", { status: 201 }); }
    if (m === "PUT") { files.set(p, String(opts.body)); return new Response("", { status: 201 }); }
    if (m === "GET") return files.has(p) ? new Response(files.get(p), { status: 200 }) : new Response("", { status: 404 });
    if (m === "PROPFIND") {
      if (!dirs.has(p)) return new Response("", { status: 404 });
      const kids = new Set();
      for (const d of dirs) if (d && d.startsWith(p ? p + "/" : "") && d !== p) kids.add(d.slice(p ? p.length + 1 : 0).split("/")[0]);
      for (const k of files.keys()) if (k.startsWith(p ? p + "/" : "")) kids.add(k.slice(p ? p.length + 1 : 0).split("/")[0]);
      const href = (n) => `<d:response><d:href>/${p ? p + "/" : ""}${n}</d:href></d:response>`;
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/${p}/</d:href></d:response>${[...kids].map(href).join("")}</d:multistatus>`, { status: 207 });
    }
    return new Response("", { status: 405 });
  };
  return { files, dirs, handler };
}

export function makeMiniflux({ faults = () => null } = {}) {
  const st = { feeds: [], entries: [], calls: [], puts: [], cats: [], discover: {}, flaky: null, delay: 0, stale: null, nextFeed: 100, nextCat: 50 };
  const handler = async (url, opts = {}) => {
    const f = faults(opts.method, url); if (f === "throw") throw new TypeError("network down"); if (typeof f === "number") return new Response("", { status: f });
    const u = new URL(url); const path = u.pathname.replace(/^\/v1/, ""); const m = opts.method || "GET"; st.calls.push(`${m} ${path}`);
    if (opts.headers["X-Auth-Token"] !== "good-key") return new Response("", { status: 401 });
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (path === "/me") return json({ id: 1, username: "ap" });
    if (path === "/feeds" && m === "GET") return json(st.feeds);
    if (path === "/categories" && m === "GET") { if (!st.cats.length) { const seen = new Map(); for (const f of st.feeds) if (!seen.has(f.category.title)) seen.set(f.category.title, seen.size + 1); st.cats = [...seen].map(([title, id]) => ({ id, title })); } return json(st.cats); }
    if (path === "/categories" && m === "POST") { const b = JSON.parse(opts.body); if (!st.cats.length) { const seen = new Map(); for (const f of st.feeds) if (!seen.has(f.category.title)) seen.set(f.category.title, seen.size + 1); st.cats = [...seen].map(([title, id]) => ({ id, title })); } const c = { id: st.nextCat++, title: b.title }; st.cats.push(c); return json(c, 201); }
    if (path === "/discover" && m === "POST") { const b = JSON.parse(opts.body); const r = st.discover[b.url]; return r ? json(r) : json({ error_message: "Unable to find any subscription on that page." }, 500); }
    if (path === "/feeds" && m === "POST") {
      const b = JSON.parse(opts.body); if (st.feeds.some(f => f.feed_url === b.feed_url)) return json({ error_message: "This feed already exists." }, 400);
      const cat = st.cats.find(c => c.id === b.category_id); const id = st.nextFeed++;
      st.feeds.push(feed(id, `New feed ${id}`, cat ? cat.title : "All", { feed_url: b.feed_url, site_url: "https://new.example" }));
      st.entries.push({ ...entry(900 + id, id, `First article of new feed ${id}`, "Fresh content.", 1), feed: { id, title: `New feed ${id}`, category: { title: cat ? cat.title : "All" } } });
      return json({ feed_id: id }, 201);
    }
    if (path === "/entries" && m === "GET") {
      let es = st.entries.slice(); const q = u.searchParams;
      if (q.get("status")) es = es.filter(e => e.status === q.get("status"));
      if (q.get("starred") === "true") es = es.filter(e => e.starred);
      if (q.get("search")) { const w = q.get("search").toLowerCase(); es = es.filter(e => `${e.title} ${e.content}`.toLowerCase().includes(w)); }
      if (st.stale && q.get("status") === "unread") { const snap = st.stale; st.stale = null; await snap.waitFor(); es = snap.entries; }
      if (q.get("changed_after")) es = es.filter(e => (e.changed_at || 0) > Number(q.get("changed_after")));
      es.sort((a, b) => (Date.parse(b.published_at) - Date.parse(a.published_at)));
      const off = Number(q.get("offset") || 0), lim = Number(q.get("limit") || 100);
      return json({ total: es.length, entries: es.slice(off, off + lim) });
    }
    if (path === "/entries" && m === "PUT") {
      const b = JSON.parse(opts.body); st.puts.push(b.entry_ids.length); if (st.delay) await new Promise(r => setTimeout(r, st.delay));
      const skip = st.flaky && st.flaky.times > 0 ? st.flaky.ids : null; if (skip && b.entry_ids.some(i => skip.has(i))) st.flaky.times--;
      for (const e of st.entries) if (b.entry_ids.includes(e.id) && !(skip && skip.has(e.id))) e.status = b.status;
      return new Response(null, { status: 204 });
    }
    let mm;
    if ((mm = path.match(/^\/entries\/(\d+)\/bookmark$/))) { const e = st.entries.find(x => x.id === Number(mm[1])); e.starred = !e.starred; return new Response(null, { status: 204 }); }
    if ((mm = path.match(/^\/entries\/(\d+)\/fetch-content$/))) { const e = st.entries.find(x => x.id === Number(mm[1])); return e ? json({ content: e.full_content || "<p>The complete article text, fetched from the original page.</p>" }) : new Response("", { status: 404 }); }
    if ((mm = path.match(/^\/feeds\/(\d+)\/icon$/))) { const f = st.feeds.find(x => x.id === Number(mm[1])); return f && f.icon ? json({ id: f.icon.icon_id, data: "image/png;base64,iVBORw0KGgo=", mime_type: "image/png" }) : new Response("", { status: 404 }); }
    if ((mm = path.match(/^\/entries\/(\d+)$/))) { const e = st.entries.find(x => x.id === Number(mm[1])); return e ? json(e) : new Response("", { status: 404 }); }
    return new Response("", { status: 404 });
  };
  return { st, handler };
}

export function makeRaindrop({ bookmarks = [], faults = () => null } = {}) {
  const st = { bookmarks, saved: [] };
  const handler = async (url, opts = {}) => {
    const f = faults(opts.method, url); if (f === "throw") throw new TypeError("network down"); if (typeof f === "number") return new Response("", { status: f });
    const u = new URL(url); const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (opts.headers.Authorization !== "Bearer rd-token") return new Response("", { status: 401 });
    if (u.pathname.endsWith("/tags/0")) { const c = {}; for (const b of st.bookmarks) for (const t of b.tags) c[t] = (c[t] || 0) + 1; return json({ items: Object.entries(c).map(([_id, count]) => ({ _id, count })) }); }
    if (u.pathname.endsWith("/raindrops/0")) { const page = Number(u.searchParams.get("page") || 0); return json({ items: st.bookmarks.slice(page * 50, page * 50 + 50) }); }
    if (u.pathname.endsWith("/raindrop") && opts.method === "POST") { st.saved.push(JSON.parse(opts.body)); return json({ item: {} }); }
    return new Response("", { status: 404 });
  };
  return { st, handler };
}

// One fetch that routes by host, so an Engine can talk to all three fakes.
export function router({ dav, mf, rd }) {
  return async (url, opts) => {
    const host = new URL(url).host;
    if (host === "dav.test") return dav.handler(url, opts);
    if (host === "mf.test") return mf.handler(url, opts);
    if (host === "api.raindrop.io") return rd.handler(url, opts);
    throw new TypeError("unknown host " + host);
  };
}

export const feed = (id, title, category, extra = {}) => ({ id, title, category: { title: category }, parsing_error_count: 0, checked_at: new Date().toISOString(), disabled: false, ...extra });
export const entry = (id, feedId, title, content, hoursAgo = 2, extra = {}) => ({
  id, feed_id: feedId, feed: { id: feedId, title: `Feed ${feedId}`, category: { title: "News" } }, title, content: `<p>${content}</p>`,
  published_at: new Date(Date.now() - hoursAgo * 3600000).toISOString(), url: `https://site${feedId}.example/${id}`, status: "unread", starred: false, author: "", tags: [], reading_time: 3, ...extra
});
export const settings = (device, over = {}) => ({
  device, miniflux: { url: "https://mf.test", token: "good-key" }, webdav: { url: "https://dav.test", user: "u", pass: "p", root: "pravaha" },
  raindrop: { token: "rd-token" }, retentionDays: 30, ...over
});

export async function world({ flaky = {} } = {}) {
  const ctl = { mfDown: false, davDown: false, rdDown: false };
  const dav = makeDav({ faults: () => (ctl.davDown ? "throw" : null) });
  const mf = makeMiniflux({ faults: () => (ctl.mfDown ? "throw" : null) });
  const rd = makeRaindrop({ faults: () => (ctl.rdDown ? "throw" : null), bookmarks: [
    ...Array.from({ length: 24 }, (_, i) => ({ _id: i, title: `Navy frigate shipyard programme ${i}`, excerpt: "warship naval defence procurement", note: "", tags: ["defence", "shipbuilding"], link: `https://navalnews.example/${i}`, lastUpdate: new Date().toISOString() })),
    ...Array.from({ length: 6 }, (_, i) => ({ _id: 100 + i, title: `Fiscal budget deficit ${i}`, excerpt: "tax economy", note: "", tags: ["economy"], link: `https://econ.example/${i}`, lastUpdate: new Date().toISOString() }))] });
  mf.st.feeds = [feed(1, "Naval Wire", "Defence/Shipbuilding"), feed(2, "Kitchen Daily", "Food"), feed(3, "Broken Feed", "Food", { parsing_error_count: 9 })];
  mf.st.entries = [
    entry(1, 1, "Navy orders new frigates from shipyard", "The defence ministry procurement of warship frigates continues.", 3),
    entry(2, 2, "Ten lemon cake recipes for spring", "Baking and dessert ideas for your kitchen.", 1),
    entry(3, 3, "Broken feed naval frigate story", "naval shipyard", 1),
    entry(4, 1, "Fiscal deficit widens as tax receipts fall", "economy budget", 30)];
  for (const e of mf.st.entries) e.feed = { id: e.feed_id, title: mf.st.feeds.find(f => f.id === e.feed_id).title, category: mf.st.feeds.find(f => f.id === e.feed_id).category };
  const fetchImpl = router({ dav, mf, rd });
  const mk = async (device, over = {}) => {
    const storage = new MemoryStorage(); await storage.set({ settings: settings(device, over) });
    const changes = { n: 0 }; const e = new Engine({ storage, fetchImpl, onChange: () => { changes.n++; }, platform: { echoDocs: async () => [{ title: "Navy frigate shipyard news", url: "https://navalnews.example/x", visits: 5 }] } });
    await e.load(); return { e, storage, changes };
  };
  return { ctl, dav, mf, rd, mk, fetchImpl };
}
export const ids = (v) => v.groups.flatMap(g => g.rows.map(r => r.id));
