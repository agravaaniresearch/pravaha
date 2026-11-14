// The engine: owns state, talks to Miniflux, Raindrop and WebDAV, scores items, records events.
// Nothing here touches browser globals directly; the background page injects everything.
import { tokenize, domainOf, firstParagraph } from "./text.js";
import { Corpus, cosine, blend, mean, prune, topTerms } from "./vector.js";
import { scoreItem, DEFAULT_WEIGHTS, normaliseWeights, whyRanked, authorityOf } from "./scoring.js";
import { EventLog, Clock, derive } from "./eventlog.js";
import { Syncer, freshSyncState } from "./sync.js";
import { WebDav, PlainError } from "./webdav.js";
import { Miniflux, feedHealth, splitCategory } from "./miniflux.js";
import { Raindrop } from "./raindrop.js";
import { buildTagProfiles, suggestTags } from "./tagger.js";
import { computeStatus } from "./status.js";
import { buildOutbox, parseResults } from "./enrich.js";
import { buildDigest, isoWeek } from "./digest.js";

export const DEFAULT_SETTINGS = {
  device: "", miniflux: { url: "https://reader.miniflux.app", token: "" },
  webdav: { url: "https://myfiles.fastmail.com", user: "", pass: "", root: "pravaha" },
  raindrop: { token: "" }, weights: { ...DEFAULT_WEIGHTS }, pollMinutes: 2, novelty: true,
  palette: "ember", theme: "light", syncCreds: false, retentionDays: 30, autoTag: true, autoDigest: true, saveToRaindrop: true
};
const DAY = 86400000;
const UNREAD_CAP = 3000;

export class Engine {
  constructor({ storage, now = () => Date.now(), fetchImpl, platform = {}, onChange = () => {} }) {
    this.storage = storage; this.now = now; this.fetchImpl = fetchImpl; this.platform = platform; this.onChange = onChange;
    this.sessionFeeds = new Set(); this._vecs = new Map(); this._model = null; this._derived = null;
  }

  // ---------- persistence ----------
  async load() {
    const s = await this.storage.get(["settings", "cache", "events", "syncState", "pendingOps", "raindropCache", "echoLocal", "enrichment", "net", "others", "pendingHistory"]);
    this.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    this.settings.miniflux = { ...DEFAULT_SETTINGS.miniflux, ...(this.settings.miniflux || {}) };
    this.settings.webdav = { ...DEFAULT_SETTINGS.webdav, ...(this.settings.webdav || {}) };
    this.settings.raindrop = { ...DEFAULT_SETTINGS.raindrop, ...(this.settings.raindrop || {}) };
    this.settings.weights = { ...DEFAULT_WEIGHTS, ...(this.settings.weights || {}) };
    if (!this.settings.device) this.settings.device = "this-machine";
    this.cache = { items: {}, feeds: [], lastChangeTs: 0, lastDigestAt: 0, lastDigestTerms: [], ...(s.cache || {}) };
    this.pendingOps = (s.pendingOps || []).map(o => ({ ...o, inflight: false })); this.raindropCache = s.raindropCache || null; this.echoLocal = s.echoLocal || null;
    this.enrichment = s.enrichment || {}; this.net = s.net || { miniflux: {}, webdav: {}, raindrop: {} };
    this.others = s.others || {}; this.pendingHistory = s.pendingHistory || [];
    this.log = new EventLog(this.settings.device, new Clock(this.settings.device, this.now));
    this.log.merge(s.events || []);
    this.syncState = s.syncState || freshSyncState();
    this._wire();
    this._invalidate();
  }
  _wire() {
    const w = this.settings.webdav;
    this.dav = w.url && w.user && w.pass ? new WebDav({ baseUrl: w.url, user: w.user, pass: w.pass, fetchImpl: this.fetchImpl }) : null;
    this.syncer = this.dav ? new Syncer({ dav: this.dav, log: this.log, device: this.settings.device, root: w.root || "pravaha", now: this.now, state: this.syncState, localExtra: () => ({ echo: this.echoLocal }) }) : null;
    const m = this.settings.miniflux;
    this.mf = m.url && m.token ? new Miniflux({ baseUrl: m.url, token: m.token, fetchImpl: this.fetchImpl }) : null;
    this.rd = this.settings.raindrop.token ? new Raindrop({ token: this.settings.raindrop.token, fetchImpl: this.fetchImpl }) : null;
  }
  async persist(keys) {
    const all = { settings: this.settings, cache: this.cache, events: this.log.list(), syncState: this.syncState, pendingOps: this.pendingOps, raindropCache: this.raindropCache, echoLocal: this.echoLocal, enrichment: this.enrichment, net: this.net, others: this.others, pendingHistory: this.pendingHistory };
    const out = {}; for (const k of keys || Object.keys(all)) out[k] = all[k];
    await this.storage.set(out);
  }
  async saveSettings(patch) {
    const prevDevice = this.settings.device;
    this.settings = { ...this.settings, ...patch,
      miniflux: { ...this.settings.miniflux, ...(patch.miniflux || {}) }, webdav: { ...this.settings.webdav, ...(patch.webdav || {}) },
      raindrop: { ...this.settings.raindrop, ...(patch.raindrop || {}) }, weights: normaliseWeights({ ...this.settings.weights, ...(patch.weights || {}) }) };
    if (this.settings.device !== prevDevice) {
      const events = this.log.list(); this.log = new EventLog(this.settings.device, new Clock(this.settings.device, this.now)); this.log.merge(events);
      this.syncState = freshSyncState();
    }
    this._wire(); this._invalidate(); await this.persist(); this.onChange();
  }
  _invalidate() { this._model = null; this._derived = null; this._vecs.clear(); }

  // ---------- model ----------
  _derive() { if (!this._derived) this._derived = derive(this.log.list(), this.now()); return this._derived; }
  _buildModel() {
    if (this._model) return this._model;
    const bms = (this.raindropCache && this.raindropCache.bookmarks) || [];
    const corpus = new Corpus();
    const text = (b) => `${(b.tags || []).join(" ")} ${(b.tags || []).join(" ")} ${b.note || ""} ${b.title || ""} ${b.excerpt || ""}`;
    for (const b of bms) corpus.add(tokenize(text(b)));
    if (corpus.n < 20) for (const it of Object.values(this.cache.items)) corpus.add(tokenize(`${it.title} ${it.summary}`));
    const now = this.now();
    const vecs = bms.map(b => corpus.vector(tokenize(text(b))));
    const weights = bms.map(b => Math.pow(0.5, Math.max(0, now - (b.at || now)) / (365 * DAY)));
    let centroid = prune(mean(vecs, weights), 500);
    const d = this._derive();
    for (const p of d.pulls) centroid = blend(centroid, corpus.vector(p.terms), p.kind === "save" ? 0.12 : 0.05);
    const echo = this._echoMerged(corpus);
    this._model = { corpus, centroid, echo: echo.vec, domainVisits: echo.domainVisits, profiles: buildTagProfiles(bms, corpus) };
    return this._model;
  }
  _echoMerged(corpus) {
    const srcs = [];
    if (this.echoLocal) srcs.push({ device: this.settings.device, ...this.echoLocal });
    for (const [dev, s] of Object.entries(this.others)) if (s && s.echo) srcs.push({ device: dev, ...s.echo });
    srcs.sort((a, b) => (a.device < b.device ? -1 : 1));
    const domainVisits = {}; for (const s of srcs) for (const [d, n] of Object.entries(s.domainCounts || {})) domainVisits[d] = (domainVisits[d] || 0) + n;
    return { vec: mean(srcs.map(s => s.vec || {})), domainVisits };
  }
  _itemVec(it) {
    let v = this._vecs.get(it.id);
    if (!v) { const m = this._buildModel(); const vec = m.corpus.vector(tokenize(`${it.title} ${it.title} ${it.summary}`)); v = { vec, stems: topTerms(vec, 12) }; this._vecs.set(it.id, v); }
    return v;
  }
  _scoreCtx() {
    const m = this._buildModel(), d = this._derive();
    return { weights: normaliseWeights(this.settings.weights), centroid: m.centroid, echo: m.echo, domainVisits: m.domainVisits, authorityDelta: d.authorityDelta,
      training: d.training, now: this.now(), sessionFeeds: this.sessionFeeds, novelty: this.settings.novelty, enrichment: this.enrichment, cosine };
  }
  scoreOne(it, ctx = this._scoreCtx()) {
    const v = this._itemVec(it);
    return scoreItem({ id: it.id, feedId: it.feedId, vec: v.vec, stems: v.stems, domain: it.domain, publishedAt: it.publishedAt, author: it.author, tags: it.tags }, ctx);
  }

  // ---------- Miniflux ----------
  _norm(e, prev = {}) {
    const feed = e.feed || {};
    return { ...prev, id: e.id, feedId: e.feed_id || feed.id, feedTitle: feed.title || prev.feedTitle || "Unknown feed",
      category: (feed.category && feed.category.title) || prev.category || "Uncategorised",
      title: e.title || "(untitled)", summary: firstParagraph(e.content, 320), publishedAt: Date.parse(e.published_at) || prev.publishedAt || 0,
      author: e.author || null, url: e.url, domain: domainOf(e.url), tags: e.tags || [], status: e.status, starred: !!e.starred, readingTime: e.reading_time || 0 };
  }
  _pendingIds() { const s = new Set(); for (const o of this.pendingOps) { if (o.op === "status") o.ids.forEach(i => s.add(i)); else s.add(o.id); } return s; }

  // One flush at a time. An op that is being sent is marked in flight, so a later change can never be
  // merged into it and then dropped when it completes.
  flushOps() {
    if (!this.mf || !this.pendingOps.length) return Promise.resolve();
    if (!this._flushP) this._flushP = this._flush().finally(() => { this._flushP = null; });
    return this._flushP;
  }
  async _flush() {
    try {
      while (this.pendingOps.length) {
        const o = this.pendingOps[0]; o.inflight = true;
        try {
          if (o.op === "status") await this.mf.setStatus(o.ids, o.status);
          else if (o.op === "bookmark") { const e = await this.mf.entry(o.id); if (!!e.starred !== o.desired) await this.mf.toggleBookmark(o.id); }
        } catch (err) { o.inflight = false; throw err; }
        const i = this.pendingOps.indexOf(o); if (i >= 0) this.pendingOps.splice(i, 1);
      }
      this._netOk("miniflux");
    } catch (e) { this._netErr("miniflux", e); }
    await this.persist(["pendingOps", "net"]);
  }
  _queue(op) {
    const last = this.pendingOps[this.pendingOps.length - 1];
    if (op.op === "status" && last && last.op === "status" && last.status === op.status && !last.inflight) last.ids = [...new Set([...last.ids, ...op.ids])];
    else this.pendingOps.push(op);
  }
  _netOk(k) { this.net[k] = { error: null, lastOkAt: this.now() }; }
  _netErr(k, e) { this.net[k] = { ...(this.net[k] || {}), error: { plain: e instanceof PlainError ? e.plain : "Something unexpected went wrong; the details were not shown. Try again shortly.", code: e.code || "error" } }; }

  async refresh() {
    if (!this.mf) return;
    try {
      await this.flushOps();
      const feeds = await this.mf.feeds();
      this.cache.feeds = feeds.map(f => ({ id: f.id, title: f.title, category: (f.category && f.category.title) || "Uncategorised", health: feedHealth(f, this.now()) }));
      const un = await this.mf.allUnread(UNREAD_CAP);
      const capped = un.entries.length >= UNREAD_CAP && un.total > un.entries.length;
      const pend = this._pendingIds(); const serverIds = new Set();
      for (const e of un.entries) { serverIds.add(e.id); if (pend.has(e.id)) continue; this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      if (!capped) for (const it of Object.values(this.cache.items)) if (it.status === "unread" && !serverIds.has(it.id) && !pend.has(it.id)) it.status = "read";
      const starred = await this.mf.entries({ starred: "true", limit: 250, order: "published_at", direction: "desc" });
      const starIds = new Set();
      for (const e of starred.entries || []) { starIds.add(e.id); if (pend.has(e.id)) continue; this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      if ((starred.entries || []).length < 250) for (const it of Object.values(this.cache.items)) if (it.starred && !starIds.has(it.id) && !pend.has(it.id)) it.starred = false;
      if (this.cache.lastChangeTs) {
        for (const e of await this.mf.changedSince(this.cache.lastChangeTs)) { if (pend.has(e.id)) continue; if (this.cache.items[e.id] || e.status === "unread") this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      }
      this.cache.lastChangeTs = Math.floor(this.now() / 1000) - 5;
      this._retain();
      this._netOk("miniflux"); this._vecs.clear();
    } catch (e) { this._netErr("miniflux", e); }
    await this.persist(["cache", "net", "pendingOps"]);
  }
  _retain() {
    const cut = this.now() - this.settings.retentionDays * DAY; const d = this._derive();
    for (const it of Object.values(this.cache.items))
      if (it.status === "read" && !it.starred && !d.opens.has(it.id) && it.publishedAt < cut) delete this.cache.items[it.id];
  }

  // ---------- Raindrop and echo ----------
  async refreshRaindrop(force = false) {
    if (!this.rd) return;
    if (!force && this.raindropCache && this.now() - this.raindropCache.at < DAY) return;
    try {
      const bms = await this.rd.bookmarks();
      this.raindropCache = { at: this.now(), bookmarks: bms.map(({ title, excerpt, note, tags, domain, at }) => ({ title, excerpt, note, tags, domain, at })) };
      this._netOk("raindrop"); this._invalidate();
    } catch (e) { this._netErr("raindrop", e); }
    await this.persist(["raindropCache", "net"]);
  }
  async refreshEcho(force = false) {
    if (!this.platform.echoDocs) return;
    if (!force && this.echoLocal && this.now() - this.echoLocal.at < DAY) return;
    const docs = await this.platform.echoDocs(90); // [{title,url,visits}]
    const corpus = this._buildModel().corpus; const domainCounts = {}; const vecs = [], w = [];
    for (const d of docs) {
      const dom = domainOf(d.url); if (dom) domainCounts[dom] = (domainCounts[dom] || 0) + (d.visits || 1);
      const t = tokenize(d.title); if (t.length) { vecs.push(corpus.vector(t)); w.push(1 + Math.log(1 + (d.visits || 1))); }
    }
    this.echoLocal = { at: this.now(), vec: prune(mean(vecs, w), 300), domainCounts };
    this._invalidate(); await this.persist(["echoLocal"]);
  }

  // ---------- sync ----------
  async syncNow() {
    await this.refresh();
    await this.refreshRaindrop();
    await this.refreshEcho();
    if (this.syncer) {
      const r = await this.syncer.sync();
      if (r.ok) { this._netOk("webdav"); this.others = r.others; this._invalidate(); await this._enrich(); await this._autoDigest(); }
      else this._netErr("webdav", new PlainError(r.error.plain, r.error.code));
      this.pendingHistory.push({ at: this.now(), pending: this.syncer.pending().length }); this.pendingHistory = this.pendingHistory.slice(-120);
    }
    await this.persist(); this.onChange();
  }
  async _enrich() {
    try {
      const root = this.settings.webdav.root || "pravaha";
      const res = await this.dav.get(`${root}/enrich/results.json`);
      if (res) this.enrichment = parseResults(res).map;
      const scored = this._unreadScored();
      await this.dav.put(`${root}/enrich/outbox.json`, JSON.stringify(buildOutbox({ items: scored.map(s => ({ ...s.it, score: s.s.score })), centroidTerms: topTerms(this._buildModel().centroid, 30), now: this.now() }), null, 1));
    } catch { /* enrichment is optional; failures here must not mark the sync as failed */ }
  }
  async _autoDigest() { if (this.settings.autoDigest && this.now() - this.cache.lastDigestAt > DAY) await this.writeDigest().catch(() => {}); }

  status() {
    const feeds = this.cache.feeds || [];
    return computeStatus({
      now: this.now(), device: this.settings.device, myHead: this.log.headOf(this.settings.device), remoteHeads: this.syncState.remoteHeads, others: this.others,
      miniflux: { configured: !!this.mf, error: this.net.miniflux && this.net.miniflux.error, lastOkAt: this.net.miniflux && this.net.miniflux.lastOkAt },
      webdav: { configured: !!this.dav, error: this.net.webdav && this.net.webdav.error, lastOkAt: this.net.webdav && this.net.webdav.lastOkAt },
      raindrop: { configured: !!this.rd, error: this.net.raindrop && this.net.raindrop.error, lastOkAt: this.net.raindrop && this.net.raindrop.lastOkAt },
      pendingOps: this.pendingOps.reduce((n, o) => n + (o.ids ? o.ids.length : 1), 0), pendingEvents: this.syncer ? this.syncer.pending().length : this.log.own().length, corruptLines: this.syncState.corruptLines,
      feeds: { total: feeds.length, dead: feeds.filter(f => f.health.dead).length, trouble: feeds.filter(f => f.health.state === "amber").length }
    });
  }

  // ---------- views ----------
  _unreadScored() {
    const ctx = this._scoreCtx(); const d = this._derive();
    return Object.values(this.cache.items).filter(i => i.status === "unread" && !d.dismissed.has(i.id)).map(it => ({ it, s: this.scoreOne(it, ctx) }));
  }
  _feedMeta() { const m = {}; for (const f of this.cache.feeds) m[f.id] = f; return m; }
  tree() {
    const d = this._derive(); const nodes = new Map(); const out = [];
    const unreadBy = {}; for (const it of Object.values(this.cache.items)) if (it.status === "unread" && !d.dismissed.has(it.id)) unreadBy[it.feedId] = (unreadBy[it.feedId] || 0) + 1;
    const ensure = (path) => {
      const id = "cat:" + path.join("/"); if (nodes.has(id)) return nodes.get(id);
      const parent = path.length > 1 ? ensure(path.slice(0, -1)) : null;
      const n = { id, type: "folder", label: path[path.length - 1], depth: path.length - 1, parent: parent && parent.id, unread: 0, order: path.join("/").toLowerCase() };
      nodes.set(id, n); return n;
    };
    const feeds = [...this.cache.feeds].sort((a, b) => a.title.localeCompare(b.title));
    for (const f of feeds) {
      const path = splitCategory(f.category); const folder = ensure(path);
      const n = { id: "feed:" + f.id, type: "feed", label: f.title, depth: folder.depth + 1, parent: folder.id, unread: unreadBy[f.id] || 0, state: f.health.state, order: path.join("/").toLowerCase() + "/~" + f.title.toLowerCase() };
      nodes.set(n.id, n);
      for (let p = folder; p; p = p.parent ? nodes.get(p.parent) : null) p.unread += n.unread;
    }
    return [...nodes.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }
  getView({ scope = "all", mode = "unread", ranked = false, q = "", keep = [] } = {}) {
    const d = this._derive(); const ctx = this._scoreCtx(); const keepSet = new Set(keep); const meta = this._feedMeta();
    const ql = q.trim().toLowerCase(); const dead = new Set(this.cache.feeds.filter(f => f.health.dead).map(f => f.id));
    const matchScope = (it) => scope === "all" || scope === "saved" ? true : scope.startsWith("feed:") ? "feed:" + it.feedId === scope :
      (() => { const p = splitCategory((meta[it.feedId] && meta[it.feedId].category) || it.category).join("/"); const want = scope.slice(4); return p === want || p.startsWith(want + "/"); })();
    let items = Object.values(this.cache.items).filter(it => !d.dismissed.has(it.id) && matchScope(it));
    if (scope === "saved") items = items.filter(it => it.starred);
    else if (mode === "unread") items = items.filter(it => it.status === "unread" || keepSet.has(it.id));
    if (ql) items = items.filter(it => `${it.title} ${it.summary} ${it.feedTitle}`.toLowerCase().includes(ql));
    const rows = items.map(it => {
      const s = this.scoreOne(it, ctx);
      return { id: it.id, feedId: it.feedId, feedTitle: it.feedTitle, title: it.title, summary: it.summary, url: it.url, publishedAt: it.publishedAt, read: it.status === "read", saved: it.starred,
        score: s.score, why: whyRanked(s.breakdown), breakdown: s.breakdown, flag: s.flag, author: it.author, readingTime: it.readingTime, dead: dead.has(it.feedId) };
    });
    let groups;
    if (ranked) {
      const r = rows.filter(x => !x.dead).sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
      groups = [{ key: "ranked", title: "Ranked for you", unread: r.filter(x => !x.read).length, rows: r }];
    } else {
      const by = new Map(); for (const r of rows) { if (!by.has(r.feedId)) by.set(r.feedId, []); by.get(r.feedId).push(r); }
      groups = [...by.entries()].map(([id, rs]) => ({ key: "feed:" + id, feedId: Number(id), title: rs[0].feedTitle, unread: rs.filter(x => !x.read).length, rows: rs.sort((a, b) => b.publishedAt - a.publishedAt) }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    return { groups, total: rows.length, unreadTotal: Object.values(this.cache.items).filter(i => i.status === "unread" && !d.dismissed.has(i.id)).length, dismissedCount: d.dismissed.size };
  }
  suggestTagsFor(id) { const it = this.cache.items[id]; if (!it) return []; const v = this._itemVec(it); return suggestTags(v.vec, v.stems, this._buildModel().profiles); }

  // ---------- actions ----------
  _evt(it, type, extra = {}) {
    const v = this._itemVec(it);
    this.log.append(type, { entry: it.id, feed: it.feedId, payload: { terms: v.stems, score: this.scoreOne(it).score, ...extra } });
    this._derived = null; this._model = null;
  }
  async markRead(ids, { explicit = false } = {}) {
    for (const id of ids) { const it = this.cache.items[id]; if (!it || it.status === "read") continue; it.status = "read"; if (explicit && ids.length === 1) this._evt(it, "read_no_open"); }
    this._queue({ op: "status", ids: [...ids], status: "read" }); await this.persist(); this.onChange(); await this.flushOps(); this.onChange();
  }
  async markUnread(ids) {
    for (const id of ids) { const it = this.cache.items[id]; if (it) it.status = "unread"; }
    this._queue({ op: "status", ids: [...ids], status: "unread" }); await this.persist(); this.onChange(); await this.flushOps(); this.onChange();
  }
  async open(id) {
    const it = this.cache.items[id]; if (!it) return null;
    this._evt(it, "open"); this.sessionFeeds.add(it.feedId);
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(); this.onChange(); this.flushOps().then(() => this.onChange());
    return { url: it.url, feedId: it.feedId };
  }
  async recordDwell(entryId, feedId, ms) {
    if (ms < 1000) return; this.log.append("dwell", { entry: entryId, feed: feedId, payload: { ms: Math.round(ms) } });
    this._derived = null; this._model = null; await this.persist(["events"]); this.onChange();
  }
  async toggleSave(id) {
    const it = this.cache.items[id]; if (!it) return;
    it.starred = !it.starred; this._evt(it, it.starred ? "save" : "unsave");
    this.pendingOps = this.pendingOps.filter(o => !(o.op === "bookmark" && o.id === id)); this._queue({ op: "bookmark", id, desired: it.starred });
    let tags = [];
    if (it.starred && this.rd && this.settings.saveToRaindrop) {
      if (this.settings.autoTag) tags = this.suggestTagsFor(id).map(t => t.tag);
      this.rd.save({ link: it.url, title: it.title, tags }).then(() => this._netOk("raindrop")).catch(e => { this._netErr("raindrop", e); this.onChange(); });
    }
    await this.persist(); this.onChange(); await this.flushOps(); this.onChange();
    return { saved: it.starred, tags };
  }
  async dismiss(id) {
    const it = this.cache.items[id]; if (!it) return;
    this._evt(it, "dismiss");
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(); this.onChange(); await this.flushOps(); this.onChange();
  }
  async undismissAll() {
    const d = this._derive();
    for (const id of d.dismissed) { const it = this.cache.items[id]; this.log.append("undismiss", { entry: id, feed: it && it.feedId }); }
    this._derived = null; this._model = null; await this.persist(); this.onChange();
  }
  async train(type, key, value) { this.log.append("train", { payload: { type, key: String(key).toLowerCase(), value } }); this._derived = null; this._model = null; await this.persist(["events"]); this.onChange(); }
  trainingRules() { return this._derive().training; }

  // ---------- stats and digest ----------
  stats() {
    const now = this.now(), d = this._derive(), events = this.log.list().filter(e => now - Number(e.ts.split(".")[0]) < 30 * DAY);
    const cat = {}; const meta = this._feedMeta();
    let opens = 0, saves = 0, dismisses = 0, dwellMs = 0;
    for (const e of events) {
      if (e.type === "open") opens++; else if (e.type === "dismiss") dismisses++; else if (e.type === "dwell") dwellMs += (e.payload && e.payload.ms) || 0;
      else if (e.type === "save") { saves++; const c = splitCategory((meta[e.feed] && meta[e.feed].category) || "Other")[0]; cat[c] = (cat[c] || 0) + 1; }
    }
    const bands = [[0, .15], [.15, .3], [.3, .45], [.45, 1.01]].map(([lo, hi]) => ({ lo, hi: Math.min(hi, 1), n: 0, opened: 0, saved: 0 }));
    const ctx = this._scoreCtx();
    for (const it of Object.values(this.cache.items)) { const s = this.scoreOne(it, ctx).score; const b = bands.find(x => s >= x.lo && s < x.hi) || bands[3]; b.n++; if (d.opens.has(it.id)) b.opened++; if (it.starred) b.saved++; }
    const league = this.cache.feeds.map(f => ({ id: f.id, title: f.title, authority: authorityOf(d.authorityDelta[f.id] || 0), health: f.health.state }))
      .sort((a, b) => b.authority - a.authority).slice(0, 12);
    return { opens, saves, dismisses, dwellMinutes: Math.round(dwellMs / 60000), savesByFolder: Object.entries(cat).sort((a, b) => b[1] - a[1]), bands, league, pendingHistory: this.pendingHistory };
  }
  async writeDigest() {
    if (!this.dav) throw new PlainError("The digest needs the WebDAV storage to be set up first.", "not-configured");
    const now = this.now(), d = this._derive(); const sc = this._unreadScored();
    const week = isoWeek(now);
    const top = sc.filter(x => now - x.it.publishedAt < 7 * DAY).sort((a, b) => b.s.score - a.s.score).slice(0, 15).map(x => ({ ...x.it, score: x.s.score }));
    const saved = Object.values(this.cache.items).filter(i => i.starred && now - i.publishedAt < 14 * DAY).map(i => ({ ...i, tags: this.suggestTagsFor(i.id).map(t => t.tag) }));
    const meta = this._feedMeta();
    const authority = Object.entries(d.authorityDelta).map(([id, v]) => ({ title: (meta[id] && meta[id].title) || id, value: authorityOf(v) })).sort((a, b) => b.value - a.value);
    const terms = topTerms(this._buildModel().centroid, 15);
    const md = buildDigest({ now, week, top, saved, authority, centroidTerms: terms, previousTerms: this.cache.lastDigestTerms });
    await this.dav.mkdirs(`${this.settings.webdav.root}/digests`);
    await this.dav.put(`${this.settings.webdav.root}/digests/${week}.md`, md);
    this.cache.lastDigestAt = now; this.cache.lastDigestTerms = terms; await this.persist(["cache"]);
    return { week, md };
  }
}

export class MemoryStorage {
  constructor() { this.d = {}; }
  async get(keys) { const o = {}; for (const k of keys) if (k in this.d) o[k] = JSON.parse(JSON.stringify(this.d[k])); return o; }
  async set(o) { for (const k of Object.keys(o)) this.d[k] = JSON.parse(JSON.stringify(o[k])); }
}
