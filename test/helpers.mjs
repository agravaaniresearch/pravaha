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
  const st = { feeds: [], entries: [], calls: [] };
  const handler = async (url, opts = {}) => {
    const f = faults(opts.method, url); if (f === "throw") throw new TypeError("network down"); if (typeof f === "number") return new Response("", { status: f });
    const u = new URL(url); const path = u.pathname.replace(/^\/v1/, ""); const m = opts.method || "GET"; st.calls.push(`${m} ${path}`);
    if (opts.headers["X-Auth-Token"] !== "good-key") return new Response("", { status: 401 });
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (path === "/me") return json({ id: 1, username: "ap" });
    if (path === "/feeds" && m === "GET") return json(st.feeds);
    if (path === "/entries" && m === "GET") {
      let es = st.entries.slice(); const q = u.searchParams;
      if (q.get("status")) es = es.filter(e => e.status === q.get("status"));
      if (q.get("starred") === "true") es = es.filter(e => e.starred);
      if (q.get("changed_after")) es = es.filter(e => (e.changed_at || 0) > Number(q.get("changed_after")));
      es.sort((a, b) => (Date.parse(b.published_at) - Date.parse(a.published_at)));
      const off = Number(q.get("offset") || 0), lim = Number(q.get("limit") || 100);
      return json({ total: es.length, entries: es.slice(off, off + lim) });
    }
    if (path === "/entries" && m === "PUT") { const b = JSON.parse(opts.body); for (const e of st.entries) if (b.entry_ids.includes(e.id)) e.status = b.status; return new Response(null, { status: 204 }); }
    let mm;
    if ((mm = path.match(/^\/entries\/(\d+)\/bookmark$/))) { const e = st.entries.find(x => x.id === Number(mm[1])); e.starred = !e.starred; return new Response(null, { status: 204 }); }
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
