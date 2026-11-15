// The engine: owns state, talks to Miniflux, Raindrop and WebDAV, scores items, records events.
// Nothing here touches browser globals directly; the background page injects everything.
import { tokenize, domainOf, firstParagraph, wordCount } from "./text.js";
import { Corpus, cosine, blend, mean, prune, topTerms } from "./vector.js";
import { scoreItem, DEFAULT_WEIGHTS, normaliseWeights, whyRanked, authorityOf } from "./scoring.js";
import { EventLog, Clock, derive, parseTs } from "./eventlog.js";
import { Syncer, freshSyncState } from "./sync.js";
import { WebDav, PlainError } from "./webdav.js";
import { Miniflux, feedHealth, splitCategory } from "./miniflux.js";
import { Raindrop } from "./raindrop.js";
import { buildTagProfiles, suggestTags } from "./tagger.js";
import { computeStatus } from "./status.js";
import { buildOutbox, parseResults } from "./enrich.js";
import { buildDigest, isoWeek } from "./digest.js";
import { indexEntry, runSearch, parseQuery } from "./search.js";

export const DEFAULT_SETTINGS = {
  device: "", miniflux: { url: "https://reader.miniflux.app", token: "" },
  webdav: { url: "https://myfiles.fastmail.com", user: "", pass: "", root: "pravaha" },
  raindrop: { token: "" }, weights: { ...DEFAULT_WEIGHTS }, pollMinutes: 2, novelty: true,
  palette: "ember", theme: "light", sync: { keys: true, settings: true }, syncMeta: {}, ui: null, retentionDays: 30, autoTag: true, autoDigest: true, saveToRaindrop: true, treeOrder: {}, treeOrderAt: 0, searchKeepDays: 400
};
const DAY = 86400000;
const randomId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const UNREAD_CAP = 3000;

const mediaKind = (encs) => { const m = (encs || []).map(x => String(x.mime_type || "")).find(t => /^(audio|video)\//.test(t)); return m ? m.split("/")[0] : null; };
const ICON_RE = /^image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const BODY_CAP = 150;
const CHUNK = 150;
const INDEX_CAP = 20000;
const VERIFY_ROUNDS = 3;
const RECENT_MS = 10 * 60000;
const RECENT_TRIES = 3;
const QUIET_MS = 1500;

export class Engine {
  constructor({ storage, now = () => Date.now(), fetchImpl, platform = {}, onChange = () => {} }) {
    this.storage = storage; this.now = now; this.fetchImpl = fetchImpl; this.platform = platform; this.onChange = onChange;
    this.sessionFeeds = new Set(); this._settled = new Map(); this.activity = null; this._muted = false; this._mutedAt = 0; this._heldChange = false; this.searchIndex = {}; this._vecs = new Map(); this._model = null; this._derived = null;
  }

  // ---------- persistence ----------
  async load() {
    const s = await this.storage.get(["settings", "cache", "events", "syncState", "pendingOps", "raindropCache", "echoLocal", "enrichment", "net", "others", "pendingHistory", "bodies", "icons", "searchIndex"]);
    this.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    this.settings.miniflux = { ...DEFAULT_SETTINGS.miniflux, ...(this.settings.miniflux || {}) };
    this.settings.webdav = { ...DEFAULT_SETTINGS.webdav, ...(this.settings.webdav || {}) };
    this.settings.raindrop = { ...DEFAULT_SETTINGS.raindrop, ...(this.settings.raindrop || {}) };
    this.settings.weights = { ...DEFAULT_WEIGHTS, ...(this.settings.weights || {}) };
    if (!this.settings.treeOrder || typeof this.settings.treeOrder !== "object") this.settings.treeOrder = {};
    this.settings.sync = { ...DEFAULT_SETTINGS.sync, ...(this.settings.sync || {}) }; this.settings.syncMeta = { ...(this.settings.syncMeta || {}) };
    let fresh = false;
    // The old default name was shared by every install, which would make two machines write one log. A machine that has written nothing yet is safe to rename.
    const untouched = !(s.events && s.events.length) && !((s.syncState || {}).pushedSeq);
    if (!this.settings.device || (this.settings.device === "this-machine" && untouched)) { this.settings.device = "browser-" + randomId(5); fresh = true; }
    if (!this.settings.installId) { this.settings.installId = randomId(12); fresh = true; }
    this.cache = { items: {}, feeds: [], lastChangeTs: 0, lastDigestAt: 0, lastDigestTerms: [], ...(s.cache || {}) };
    this.pendingOps = (s.pendingOps || []).map(o => ({ ...o, inflight: false })); this.raindropCache = s.raindropCache || null; this.echoLocal = s.echoLocal || null;
    this.enrichment = s.enrichment || {}; this.net = s.net || { miniflux: {}, webdav: {}, raindrop: {} };
    this.searchIndex = s.searchIndex || {}; this.bodies = s.bodies || {}; this.icons = s.icons || {}; this.sessionCards = new Set(); this.others = s.others || {}; this.pendingHistory = s.pendingHistory || [];
    this.log = new EventLog(this.settings.device, new Clock(this.settings.device, this.now));
    this.log.merge(s.events || []);
    this.syncState = s.syncState || freshSyncState();
    this._wire();
    this._invalidate();
    if (fresh) await this.persist(["settings"]);
  }
  _wire() {
    const w = this.settings.webdav;
    this.dav = w.url && w.user && w.pass ? new WebDav({ baseUrl: w.url, user: w.user, pass: w.pass, fetchImpl: this.fetchImpl }) : null;
    this.syncer = this.dav ? new Syncer({ dav: this.dav, log: this.log, device: this.settings.device, installId: this.settings.installId, root: w.root || "pravaha", now: this.now, state: this.syncState, localExtra: () => ({ echo: this.echoLocal }) }) : null;
    if (this.syncer) this.syncer.onProgress = (p) => { if (p.device) this._act("history", `Reading history from ${p.device}`, p.done, p.total); else this._actEnd("history"); };
    const m = this.settings.miniflux;
    this.mf = m.url && m.token ? new Miniflux({ baseUrl: m.url, token: m.token, fetchImpl: this.fetchImpl }) : null;
    this.rd = this.settings.raindrop.token ? new Raindrop({ token: this.settings.raindrop.token, fetchImpl: this.fetchImpl }) : null;
  }
  async persist(keys) {
    const all = { settings: this.settings, cache: this.cache, events: this.log.list(), syncState: this.syncState, pendingOps: this.pendingOps, raindropCache: this.raindropCache, echoLocal: this.echoLocal, enrichment: this.enrichment, net: this.net, others: this.others, pendingHistory: this.pendingHistory };
    all.searchIndex = this.searchIndex;
    const out = {}; for (const k of keys || Object.keys(all).filter(x => x !== "searchIndex" || this._idxDirty)) out[k] = all[k];
    if (out.searchIndex) this._idxDirty = false;
    await this.storage.set(out);
  }
  async saveSettings(patch) {
    const prevDevice = this.settings.device;
    this.settings = { ...this.settings, ...patch,
      miniflux: { ...this.settings.miniflux, ...(patch.miniflux || {}) }, webdav: { ...this.settings.webdav, ...(patch.webdav || {}) },
      raindrop: { ...this.settings.raindrop, ...(patch.raindrop || {}) }, weights: normaliseWeights({ ...this.settings.weights, ...(patch.weights || {}) }),
      treeOrder: patch.treeOrder !== undefined ? patch.treeOrder : this.settings.treeOrder,
      sync: { ...this.settings.sync, ...(patch.sync || {}) }, syncMeta: { ...this.settings.syncMeta, ...(patch.syncMeta || {}) }, ui: patch.ui !== undefined ? patch.ui : this.settings.ui };
    if (this.settings.device !== prevDevice) {
      const events = this.log.list(); this.log = new EventLog(this.settings.device, new Clock(this.settings.device, this.now)); this.log.merge(events);
      this.syncState = freshSyncState();
    }
    this._wire(); this._invalidate(); await this.persist(); this._notify();
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
    for (const p of d.pulls) centroid = blend(centroid, corpus.vector(p.terms), p.kind === "save" ? 0.12 : p.kind === "card" ? 0.02 : 0.05);
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
      author: e.author || null, url: e.url, domain: domainOf(e.url), tags: e.tags || [], status: e.status, starred: !!e.starred, readingTime: e.reading_time || 0,
      words: e.content ? wordCount(e.content) : (prev.words || 0), thumb: (/<img[^>]+src=["'](https:\/\/[^"']{1,300})["']/i.exec(e.content || "") || [])[1] || prev.thumb || null,
      media: mediaKind(e.enclosures) || prev.media || null, comments: e.comments_url || prev.comments || null };
  }
  _pendingIds() { const s = new Set(); for (const o of this.pendingOps) { if (o.op === "status") o.ids.forEach(i => s.add(i)); else s.add(o.id); } return s; }

  // One flush at a time. An op that is being sent is marked in flight, so a later change can never be
  // merged into it and then dropped when it completes.
  flushOps() {
    if (!this.mf || !this.pendingOps.length) return Promise.resolve();
    if (!this._flushP) this._flushP = this._flush().finally(() => { this._flushP = null; });
    return this._flushP;
  }
  // Background polls are quiet: nothing is announced unless they take longer than QUIET_MS or something visible changed.
  _notify() { if (this._muted) { this._heldChange = true; return; } this.onChange(); }
  _unmuteIfSlow() { if (this._muted && this.now() - this._mutedAt > QUIET_MS) { this._muted = false; this._heldChange = false; this.onChange(); } }
  _visibleActivity() { return this._muted ? null : this.activity; }
  _act(kind, label, done = 0, total = 0) { this.activity = { kind, label, done, total, at: this.now() }; this._unmuteIfSlow(); this._notify(); }
  _actEnd(kind) { if (this.activity && (!kind || this.activity.kind === kind)) { this.activity = null; this._unmuteIfSlow(); this._notify(); } }
  // What a person could see change on screen. Times and "last sync" stamps are left out, so an idle poll compares equal.
  signature() {
    let u = 0, sv = 0; const items = Object.values(this.cache.items); for (const x of items) { if (x.status === "unread") u++; if (x.starred) sv++; }
    const errs = {}; for (const k of Object.keys(this.net || {})) errs[k] = this.net[k] && this.net[k].error ? this.net[k].error.plain : null;
    const others = {}; for (const k of Object.keys(this.others || {})) others[k] = this.others[k] && this.others[k].head;
    return [items.length, u, sv, (this.cache.feeds || []).length, this._remaining(), JSON.stringify(errs), this.log.list().length, JSON.stringify(others), JSON.stringify(this.settings), this.syncState.pushedSeq, JSON.stringify((this.cache.feeds || []).map(f => f.health && f.health.state))].join("~");
  }
  _remaining() { return this.pendingOps.reduce((n, o) => n + (o.ids ? o.ids.length : 1), 0); }
  // Status changes go to Miniflux in chunks, so one very large request cannot fail as a whole or be cut off.
  // Each chunk that succeeds is removed from the op, so a retry resends only what did not arrive.
  async _flush() {
    let done = 0;
    try {
      while (this.pendingOps.length) {
        const o = this.pendingOps[0]; o.inflight = true;
        try {
          if (o.op === "status") {
            while (o.ids.length) {
              this._act("push", "Sending changes to Miniflux", done, done + this._remaining());
              const part = o.ids.slice(0, CHUNK); await this.mf.setStatus(part, o.status);
              o.ids = o.ids.slice(part.length); done += part.length; const t = this.now(); for (const id of part) this._settled.set(id, t);
            }
          } else if (o.op === "bookmark") {
            this._act("push", "Sending changes to Miniflux", done, done + this._remaining());
            const e = await this.mf.entry(o.id); if (!!e.starred !== o.desired) await this.mf.toggleBookmark(o.id); done++; this._settled.set(o.id, this.now());
          }
        } catch (err) { o.inflight = false; throw err; }
        const i = this.pendingOps.indexOf(o); if (i >= 0) this.pendingOps.splice(i, 1);
      }
      this._netOk("miniflux");
    } catch (e) { this._netErr("miniflux", e); }
    this._actEnd("push");
    for (const [id, t] of this._settled) if (this.now() - t > 600000) this._settled.delete(id);
    await this.persist(["pendingOps", "net"]);
  }
  _queue(op) {
    // Remember what was just marked read here. If Miniflux still lists one as unread on a later refresh, it did not
    // stick, so it is sent again (a few times at most) instead of reappearing as unread in the reader.
    if (op.op === "status") { const rc = this.cache.recent || (this.cache.recent = {}); for (const id of op.ids) { if (op.status === "read") rc[id] = { t: this.now(), n: (rc[id] && rc[id].n) || 0 }; else delete rc[id]; } }
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
      const t0 = this.now(); this._act("pull", "Reading from Miniflux");
      const feeds = await this.mf.feeds();
      this.cache.feeds = feeds.map(f => ({ id: f.id, title: f.title, category: (f.category && f.category.title) || "Uncategorised", health: feedHealth(f, this.now()), siteUrl: f.site_url || "", feedUrl: f.feed_url || "", iconId: f.icon ? f.icon.icon_id : null, checkedAt: f.checked_at || null }));
      const un = await this.mf.allUnread(UNREAD_CAP);
      const capped = un.entries.length >= UNREAD_CAP && un.total > un.entries.length;
      // Anything we sent while this fetch was running may be missing from the snapshot, so it counts as pending too.
      const pend = this._pendingIds(); for (const [id, t] of this._settled) if (t > t0) pend.add(id);
      const serverIds = new Set();
      const recent = this.cache.recent || (this.cache.recent = {}); for (const id of Object.keys(recent)) if (this.now() - recent[id].t > RECENT_MS || recent[id].n >= RECENT_TRIES) delete recent[id];
      const resend = [];
      for (const e of un.entries) {
        serverIds.add(e.id); if (pend.has(e.id)) continue; const cur = this.cache.items[e.id];
        if (cur && cur.status === "read" && recent[e.id]) { recent[e.id].n++; resend.push(e.id); continue; }
        this.cache.items[e.id] = this._norm(e, cur);
      }
      if (resend.length) this._queue({ op: "status", ids: resend, status: "read" });
      if (!capped) for (const it of Object.values(this.cache.items)) if (it.status === "unread" && !serverIds.has(it.id) && !pend.has(it.id)) it.status = "read";
      const starred = await this.mf.entries({ starred: "true", limit: 250, order: "published_at", direction: "desc" });
      const starIds = new Set();
      for (const e of starred.entries || []) { starIds.add(e.id); if (pend.has(e.id)) continue; this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      if ((starred.entries || []).length < 250) for (const it of Object.values(this.cache.items)) if (it.starred && !starIds.has(it.id) && !pend.has(it.id)) it.starred = false;
      if (this.cache.lastChangeTs) {
        for (const e of await this.mf.changedSince(this.cache.lastChangeTs)) { if (pend.has(e.id)) continue; if (this.cache.items[e.id] || e.status === "unread") this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      }
      this.cache.lastChangeTs = Math.floor(this.now() / 1000) - 5;
      this._retain(); this._reindex();
      if (this.pendingOps.length) await this.flushOps();
      this._netOk("miniflux"); this._vecs.clear();
    } catch (e) { this._netErr("miniflux", e); }
    this._actEnd("pull");
    await this.persist(["cache", "net", "pendingOps", "searchIndex"]);
  }
  _retain() {
    const cut = this.now() - this.settings.retentionDays * DAY; const d = this._derive();
    for (const it of Object.values(this.cache.items))
      if (it.status === "read" && !it.starred && !d.opens.has(it.id) && !d.cards.has(it.id) && it.publishedAt < cut) delete this.cache.items[it.id];
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
  async syncNow({ quiet = false } = {}) {
    const before = quiet ? this.signature() : null;
    if (quiet) { this._muted = true; this._mutedAt = this.now(); this._heldChange = false; }
    try {
      await this.refresh();
      await this.refreshIcons();
      await this.refreshRaindrop();
      await this.refreshEcho();
      if (this.syncer) {
        const r = await this.syncer.sync();
        if (r.ok && r.pulled > 0) {
          // Only the first history from a machine is announced; the routine trickle between two active machines is not.
          const seen = (await this.storage.get(["seenDevices"])).seenDevices || []; const fresh = (r.devices || []).filter(d => !seen.includes(d));
          this.imported = { at: this.now(), events: r.pulled, devices: r.devices, fresh: fresh.length > 0 };
          if (fresh.length) await this.storage.set({ seenDevices: [...seen, ...fresh] });
        }
        if (r.ok) { this._netOk("webdav"); this.others = r.others; this._invalidate(); await this._enrich(); await this._autoDigest(); }
        else this._netErr("webdav", new PlainError(r.error.plain, r.error.code));
        this.nameClash = this.syncer.nameClash || null;
        this.pendingHistory.push({ at: this.now(), pending: this.syncer.pending().length }); this.pendingHistory = this.pendingHistory.slice(-120);
      }
      await this.persist();
    } finally {
      const announce = !quiet || !this._muted || this.signature() !== before; this._muted = false; this._heldChange = false;
      if (announce) this.onChange();
    }
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
    return { activity: this._visibleActivity(), imported: this.imported || null, nameClash: this.nameClash || null, pendingCount: this._remaining(), ...computeStatus({
      now: this.now(), device: this.settings.device, myHead: this.log.headOf(this.settings.device), remoteHeads: this.syncState.remoteHeads, others: this.others,
      miniflux: { configured: !!this.mf, error: this.net.miniflux && this.net.miniflux.error, lastOkAt: this.net.miniflux && this.net.miniflux.lastOkAt },
      webdav: { configured: !!this.dav, error: this.net.webdav && this.net.webdav.error, lastOkAt: this.net.webdav && this.net.webdav.lastOkAt },
      raindrop: { configured: !!this.rd, error: this.net.raindrop && this.net.raindrop.error, lastOkAt: this.net.raindrop && this.net.raindrop.lastOkAt },
      eventCounts: this.log.countsByDevice(), pendingOps: this.pendingOps.reduce((n, o) => n + (o.ids ? o.ids.length : 1), 0), pendingEvents: this.syncer ? this.syncer.pending().length : this.log.own().length, corruptLines: this.syncState.corruptLines,
      feeds: { total: feeds.length, dead: feeds.filter(f => f.health.dead).length, trouble: feeds.filter(f => f.health.state === "amber").length }
    }) };
  }

  // ---------- views ----------
  _unreadScored() {
    const ctx = this._scoreCtx(); const d = this._derive();
    return Object.values(this.cache.items).filter(i => i.status === "unread" && !d.dismissed.has(i.id)).map(it => ({ it, s: this.scoreOne(it, ctx) }));
  }
  _feedMeta() { const m = {}; for (const f of this.cache.feeds) m[f.id] = f; return m; }
  tree() {
    const d = this._derive(); const nodes = new Map();
    const unreadBy = {}; for (const it of Object.values(this.cache.items)) if (it.status === "unread" && !d.dismissed.has(it.id)) unreadBy[it.feedId] = (unreadBy[it.feedId] || 0) + 1;
    const ensure = (path) => {
      const id = "cat:" + path.join("/"); if (nodes.has(id)) return nodes.get(id);
      const parent = path.length > 1 ? ensure(path.slice(0, -1)) : null;
      const n = { id, type: "folder", label: path[path.length - 1], depth: path.length - 1, parent: parent && parent.id, unread: 0 };
      nodes.set(id, n); return n;
    };
    for (const f of this.cache.feeds) {
      const path = splitCategory(f.category); const folder = ensure(path);
      const n = { id: "feed:" + f.id, type: "feed", label: f.title, depth: folder.depth + 1, parent: folder.id, unread: unreadBy[f.id] || 0, state: f.health.state };
      nodes.set(n.id, n);
      for (let p = folder; p; p = p.parent ? nodes.get(p.parent) : null) p.unread += n.unread;
    }
    // Siblings follow the order the reader saved, then the alphabet. Folders come before feeds within a parent.
    const kids = new Map(); for (const n of nodes.values()) { const k = n.parent || "root"; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(n); }
    // The order from the history log wins when it is newer than the last change made here or taken from Firefox Sync.
    const saved = { ...(this.settings.treeOrder || {}) }; const at = this.settings.treeOrderAt || 0;
    for (const [k, v] of Object.entries(d.order || {})) if (v.wall > at) saved[k] = v.ids;
    const out = [];
    const walk = (key) => {
      const list = kids.get(key) || []; const ord = Array.isArray(saved[key]) ? saved[key] : [];
      const rank = (n) => { const i = ord.indexOf(n.id); return i < 0 ? 1e6 : i; };
      list.sort((a, b) => (a.type === b.type ? 0 : a.type === "folder" ? -1 : 1) || rank(a) - rank(b) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
      list.forEach((n, i) => { n.first = i === 0 || list[i - 1].type !== n.type; n.last = i === list.length - 1 || list[i + 1].type !== n.type; out.push(n); if (n.type === "folder") walk(n.id); });
    };
    walk("root"); return out;
  }
  // Only top-level folders are reordered here (feeds are ordered in Miniflux). The order is saved in settings, for Firefox Sync,
  // and written to the history log, so it arrives with the bulk transfer too.
  async setOrder(ids) {
    const t = this.tree(); const top = t.filter(x => !x.parent); const folders = top.filter(x => x.type === "folder").map(x => x.id);
    const want = [...new Set((ids || []).map(String))].filter(x => folders.includes(x)); if (!want.length) return false;
    const merged = [...want, ...top.map(x => x.id).filter(x => !want.includes(x))];
    if (JSON.stringify(merged) === JSON.stringify(top.map(x => x.id))) return false;
    const e = this.log.append("order", { payload: { scope: "root", ids: merged } }); this._derived = null;
    await this.saveSettings({ treeOrder: { ...(this.settings.treeOrder || {}), root: merged }, treeOrderAt: parseTs(e.ts).wall }); return true;
  }
  async moveNode(id, dir) {
    const t = this.tree(); const n = t.find(x => x.id === id); if (!n || n.type !== "folder" || n.parent) return false;
    const sib = t.filter(x => !x.parent && x.type === "folder").map(x => x.id); const i = sib.indexOf(id), j = i + (dir === "up" ? -1 : 1);
    if (i < 0 || j < 0 || j >= sib.length) return false; [sib[i], sib[j]] = [sib[j], sib[i]]; return this.setOrder(sib);
  }
  unreadCount() { const d = this._derive(); return Object.values(this.cache.items).filter(i => i.status === "unread" && !d.dismissed.has(i.id)).length; }
  _rowOf(it, ctx, dead, pend) {
    const s = this.scoreOne(it, ctx);
    return { id: it.id, feedId: it.feedId, feedTitle: it.feedTitle, title: it.title, summary: it.summary, url: it.url, publishedAt: it.publishedAt, read: it.status === "read", saved: it.starred,
      score: s.score, why: whyRanked(s.breakdown), breakdown: s.breakdown, flag: s.flag, author: it.author, readingTime: it.readingTime, dead: dead.has(it.feedId), domain: it.domain, tags: it.tags || [], words: it.words || 0, thumb: it.thumb || null, media: it.media || null, comments: it.comments || null, newish: it.publishedAt > this.now() - 3 * 3600000, pending: !!(pend && pend.has(it.id)) };
  }
  getView({ scope = "all", mode = "unread", ranked = false, q = "", keep = [] } = {}) {
    const d = this._derive(); const ctx = this._scoreCtx(); const keepSet = new Set(keep); const meta = this._feedMeta();
    const ql = q.trim().toLowerCase(); const dead = new Set(this.cache.feeds.filter(f => f.health.dead).map(f => f.id)); const pend = this._pendingIds();
    let items = Object.values(this.cache.items).filter(it => !d.dismissed.has(it.id) && this._inScope(scope, it, meta));
    if (scope === "saved") items = items.filter(it => it.starred);
    else if (mode === "unread") items = items.filter(it => it.status === "unread" || keepSet.has(it.id));
    if (ql) items = items.filter(it => `${it.title} ${it.summary} ${it.feedTitle}`.toLowerCase().includes(ql));
    const rows = items.map(it => this._rowOf(it, ctx, dead, pend));
    let groups;
    if (ranked) {
      const r = rows.filter(x => !x.dead).sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt);
      groups = [{ key: "ranked", title: "Ranked for you", unread: r.filter(x => !x.read).length, rows: r }];
    } else {
      const pos = new Map(); this.tree().forEach((n, i) => pos.set(n.id, i));
      const by = new Map(); for (const r of rows) { if (!by.has(r.feedId)) by.set(r.feedId, []); by.get(r.feedId).push(r); }
      groups = [...by.entries()].map(([id, rs]) => ({ key: "feed:" + id, feedId: Number(id), title: rs[0].feedTitle, unread: rs.filter(x => !x.read).length, rows: rs.sort((a, b) => b.publishedAt - a.publishedAt) }))
        .sort((a, b) => ((pos.has(a.key) ? pos.get(a.key) : 1e9) - (pos.has(b.key) ? pos.get(b.key) : 1e9)) || a.title.localeCompare(b.title));
    }
    return { groups, total: rows.length, unreadTotal: Object.values(this.cache.items).filter(i => i.status === "unread" && !d.dismissed.has(i.id)).length, dismissedCount: d.dismissed.size, iconCount: Object.keys(this.icons).length };
  }
  suggestTagsFor(id) { const it = this.cache.items[id]; if (!it) return []; const v = this._itemVec(it); return suggestTags(v.vec, v.stems, this._buildModel().profiles); }

  // ---------- actions ----------
  _evt(it, type, extra = {}) {
    const v = this._itemVec(it);
    this.log.append(type, { entry: it.id, feed: it.feedId, payload: { terms: v.stems, score: this.scoreOne(it).score, ...extra } });
    this._derived = null; this._model = null;
  }
  // Marks articles read and, for a bulk action, checks with Miniflux that every one of them really arrived.
  // Returns plain counts so the reader can say what happened.
  async markRead(ids, { explicit = false, verify } = {}) {
    ids = [...new Set(ids)]; const flipped = [];
    for (const id of ids) { const it = this.cache.items[id]; if (!it || it.status === "read") continue; it.status = "read"; flipped.push(id); if (explicit && ids.length === 1) this._evt(it, "read_no_open"); }
    const changed = flipped.length;
    if (!ids.length) return { count: 0, changed: 0, ids: [], verified: true, retried: 0, failed: 0, pending: this._remaining() };
    this._queue({ op: "status", ids: [...ids], status: "read" }); await this.persist(); this._notify(); await this.flushOps(); this._notify();
    const res = { count: ids.length, changed, ids: flipped, verified: false, retried: 0, failed: 0, pending: this._remaining() };
    if (verify === undefined ? ids.length >= 25 : verify) Object.assign(res, await this._verifyRead(ids));
    return res;
  }
  // Fetch what Miniflux still lists as unread, and resend any of ours that did not stick. A few rounds at most.
  async _verifyRead(ids) {
    const mine = new Set(ids); let retried = 0; let still = [];
    if (!this.mf) return { verified: false, retried, failed: 0, pending: this._remaining() };
    try {
      for (let round = 0; round <= VERIFY_ROUNDS; round++) {
        if (this._remaining()) { await this.flushOps(); if (this._remaining()) break; }
        this._act("verify", "Checking with Miniflux", round, VERIFY_ROUNDS + 1);
        const un = await this.mf.allUnread(UNREAD_CAP); still = un.entries.map(e => e.id).filter(id => mine.has(id) && this.cache.items[id] && this.cache.items[id].status === "read");
        if (!still.length) { this._actEnd("verify"); return { verified: true, retried, failed: 0, serverUnread: un.total, pending: 0 }; }
        if (round === VERIFY_ROUNDS) break;
        retried += still.length; this._queue({ op: "status", ids: still, status: "read" }); await this.persist(["pendingOps"]); await this.flushOps();
      }
    } catch (e) { this._netErr("miniflux", e); }
    this._actEnd("verify");
    return { verified: false, retried, failed: still.length || this._remaining(), pending: this._remaining() };
  }
  _scopeIds(scope) {
    const d = this._derive(); const meta = this._feedMeta();
    return Object.values(this.cache.items).filter(it => it.status === "unread" && !d.dismissed.has(it.id) && this._inScope(scope, it, meta)).map(it => it.id);
  }
  // Mark everything unread in a scope ("all", a folder, or a feed), whatever the reader is currently showing.
  markScope(scope) { return this.markRead(this._scopeIds(scope), { verify: true }); }
  _inScope(scope, it, meta) {
    if (scope === "all" || scope === "saved") return true;
    if (scope.startsWith("feed:")) return "feed:" + it.feedId === scope;
    const p = splitCategory((meta[it.feedId] && meta[it.feedId].category) || it.category).join("/"); const want = scope.slice(4); return p === want || p.startsWith(want + "/");
  }
  async markUnread(ids) {
    for (const id of ids) { const it = this.cache.items[id]; if (it) it.status = "unread"; }
    this._queue({ op: "status", ids: [...ids], status: "unread" }); await this.persist(); this._notify(); await this.flushOps(); this._notify();
    return { count: ids.length, pending: this._remaining() };
  }
  // The reader opened the article as an in-page card. A light positive signal, logged once per session.
  async openCard(id) {
    const it = this.cache.items[id]; if (!it) return;
    if (!this.sessionCards.has(id)) { this.sessionCards.add(id); this._evt(it, "card"); }
    this.sessionFeeds.add(it.feedId);
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(); this._notify(); await this.flushOps(); this._notify();
  }
  // ---------- local search ----------
  // The index is a compact record of every article seen: title, feed, tags, a short summary and about fourteen
  // keywords from the full text. It outlives the reading copy, so an article read months ago can still be found.
  _reindex() {
    const keepDays = Number(this.settings.searchKeepDays) || 400; const cut = this.now() - keepDays * DAY; let changed = false;
    for (const it of Object.values(this.cache.items)) {
      const cur = this.searchIndex[it.id]; const body = this.bodies[it.id];
      if (cur && cur.t === it.title && (cur.g || []).join("|") === (it.tags || []).join("|") && (cur.k || !body)) continue;
      const next = indexEntry(it, body ? body.html : null); if (cur && cur.k && !next.k) next.k = cur.k;
      this.searchIndex[it.id] = next; changed = true;
    }
    const ids = Object.keys(this.searchIndex);
    for (const id of ids) { const e = this.searchIndex[id]; if (!this.cache.items[id] && e.p && e.p < cut) { delete this.searchIndex[id]; changed = true; } }
    const left = Object.keys(this.searchIndex);
    if (left.length > INDEX_CAP) {
      const drop = left.filter(id => !this.cache.items[id]).sort((a, b) => this.searchIndex[a].p - this.searchIndex[b].p).slice(0, left.length - INDEX_CAP);
      for (const id of drop) delete this.searchIndex[id]; if (drop.length) changed = true;
    }
    if (changed) this._idxDirty = true;
  }
  _stateOf(e) { const it = this.cache.items[e.id]; return it ? { read: it.status === "read", saved: !!it.starred } : { read: true, saved: false }; }
  _pseudo(e) {
    return { id: e.id, feedId: e.fi, feedTitle: e.f, category: e.c, title: e.t, summary: e.s, url: e.u, publishedAt: e.p, author: null, tags: e.g || [], status: "read", starred: false, readingTime: 0, words: 0, thumb: null, media: null, comments: null, domain: domainOf(e.u || "") };
  }
  // Fuzzy search over everything in the index. Returns rows in the same shape as the article list.
  search(query, { limit = 150 } = {}) {
    const parsed = parseQuery(query); const found = runSearch(Object.values(this.searchIndex), parsed, { now: this.now(), limit, stateOf: (e) => this._stateOf(e) });
    const ctx = this._scoreCtx(); const dead = new Set(this.cache.feeds.filter(f => f.health.dead).map(f => f.id)); const pend = this._pendingIds();
    const terms = [...parsed.terms, ...parsed.phrases.flatMap(p => p.split(/\s+/)), ...parsed.tags];
    const rows = found.map(({ e }) => { const cached = this.cache.items[e.id]; const row = this._rowOf(cached || this._pseudo(e), ctx, dead, pend); row.indexOnly = !cached; return row; });
    return { rows, total: rows.length, terms, indexSize: Object.keys(this.searchIndex).length, empty: !(parsed.terms.length + parsed.phrases.length + parsed.tags.length + parsed.feed.length) };
  }
  // Ask Miniflux itself for older articles that the local index does not hold. Hits join the index.
  async searchServer(query) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    const q = String(query || "").replace(/(^|\s)(#|feed:|in:|since:)\S*/gi, " ").replace(/\s+/g, " ").trim();
    if (!q) return { ok: false, sentence: "Type some words to search for on Miniflux." };
    this._act("search", "Searching Miniflux");
    try {
      const r = await this.mf.entries({ search: q, limit: 50, order: "published_at", direction: "desc" }); let added = 0;
      for (const e of r.entries || []) { const it = this._norm(e, this.cache.items[e.id]); if (!this.searchIndex[e.id]) added++; this.searchIndex[e.id] = indexEntry(it, e.content || ""); }
      this._idxDirty = true; await this.persist(["searchIndex"]); this._netOk("miniflux");
      return { ok: true, found: (r.entries || []).length, added, sentence: `Miniflux found ${(r.entries || []).length} article${(r.entries || []).length === 1 ? "" : "s"}${added ? `; ${added} were new to this search.` : "."}` };
    } catch (e) { this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "The search on Miniflux failed for an unexpected reason." }; }
    finally { this._actEnd("search"); }
  }
  // Bring an old article that only the index remembers back into the cache, so the card can show it.
  async restore(id) {
    if (this.cache.items[id]) return true; if (!this.mf) return false;
    try { const e = await this.mf.entry(id); this.cache.items[id] = this._norm(e, undefined); await this.persist(["cache"]); this._notify(); return true; }
    catch (err) { this._netErr("miniflux", err); return false; }
  }

  // ---------- subscribing ----------
  async categoryList() {
    if (!this.mf) return [];
    try { const c = await this.mf.categories(); this._netOk("miniflux"); return (c || []).map(x => ({ id: x.id, title: x.title })).sort((a, b) => a.title.localeCompare(b.title)); }
    catch (e) { this._netErr("miniflux", e); return []; }
  }
  // Miniflux's own server looks at the page; this extension never contacts the site itself.
  async discover(url) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet.", feeds: [] };
    let u = String(url || "").trim(); if (!u) return { ok: false, sentence: "Enter a web address first.", feeds: [] };
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { new URL(u); } catch { return { ok: false, sentence: "That does not look like a web address.", feeds: [] }; }
    this._act("discover", "Looking for feeds");
    try {
      const r = await this.mf.discover(u); this._netOk("miniflux");
      const have = new Set(this.cache.feeds.map(f => String(f.feedUrl || "")));
      const feeds = (r || []).filter(f => f && /^https?:\/\//i.test(f.url || "")).map(f => ({ url: f.url, title: String(f.title || f.url).slice(0, 160), type: String(f.type || "").slice(0, 12), subscribed: have.has(f.url) }));
      return { ok: true, url: u, feeds, sentence: feeds.length ? `Found ${feeds.length} feed${feeds.length === 1 ? "" : "s"}.` : "No feed was found on that page." };
    } catch (e) { return { ok: false, feeds: [], sentence: e instanceof PlainError ? e.plain : "The search for feeds failed for an unexpected reason." }; }
    finally { this._actEnd("discover"); }
  }
  async subscribe({ feedUrl, categoryId, newCategory }) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    if (!/^https?:\/\//i.test(String(feedUrl || ""))) return { ok: false, sentence: "That feed address is not valid." };
    this._act("subscribe", "Subscribing");
    try {
      let cid = Number(categoryId) || 0; const title = String(newCategory || "").trim().slice(0, 120);
      if (title) { const c = await this.mf.createCategory(title); cid = c.id; }
      if (!cid) { const all = await this.mf.categories(); cid = (all && all[0] && all[0].id) || 1; }
      const r = await this.mf.createFeed({ feed_url: feedUrl, category_id: cid }); this._netOk("miniflux");
      await this.refresh();
      const f = this.cache.feeds.find(x => x.id === r.feed_id);
      return { ok: true, feedId: r.feed_id, title: f ? f.title : "the feed", sentence: `Subscribed to ${f ? f.title : "the feed"}.` };
    } catch (e) { this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "Subscribing failed for an unexpected reason." }; }
    finally { this._actEnd("subscribe"); }
  }

  async _saveBodies() {
    this._reindex();
    const keys = Object.keys(this.bodies);
    if (keys.length > BODY_CAP) for (const k of keys.sort((a, b) => this.bodies[a].at - this.bodies[b].at).slice(0, keys.length - BODY_CAP)) delete this.bodies[k];
    await this.storage.set(this._idxDirty ? { bodies: this.bodies, searchIndex: this.searchIndex } : { bodies: this.bodies }); this._idxDirty = false;
  }
  // The article body for the card: what Miniflux holds for the entry, fetched on demand and kept for the last 150 cards.
  async getContent(id) {
    const it = this.cache.items[id]; if (!it) return { html: null, error: "That article is no longer in the local copy." };
    const b = this.bodies[id]; if (b) return { html: b.html, full: b.full };
    if (!this.mf) return { html: null, error: "Miniflux is not set up, so only the summary is available." };
    try {
      const e = await this.mf.entry(id); const html = e.content || "";
      this.bodies[id] = { html, full: false, at: this.now() }; await this._saveBodies(); return { html, full: false };
    } catch (err) { return { html: null, error: err instanceof PlainError ? err.plain : "The article text could not be loaded. Showing the summary instead." }; }
  }
  // Ask Miniflux to download the original page and extract the whole article (the "coffee cup" action).
  async fetchFull(id) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    try {
      const r = await this.mf.fetchContent(id); const html = (r && r.content) || "";
      if (!html.trim()) return { ok: false, sentence: "Miniflux could not extract the full article from that page." };
      this.bodies[id] = { html, full: true, at: this.now() }; await this._saveBodies();
      const it = this.cache.items[id]; if (it) { it.words = wordCount(html); await this.persist(["cache"]); }
      return { ok: true, html, full: true };
    } catch (err) { return { ok: false, sentence: err instanceof PlainError ? err.plain : "The full article could not be fetched. Try again shortly." }; }
  }
  // Feed icons come from Miniflux itself, so no request goes to a third-party icon service.
  async refreshIcons() {
    if (!this.mf) return;
    const need = this.cache.feeds.filter(f => f.iconId && this.icons[f.id] === undefined).slice(0, 25);
    if (!need.length) return;
    for (let i = 0; i < need.length; i += 5) {
      await Promise.all(need.slice(i, i + 5).map(async (f) => {
        try { const r = await this.mf.feedIcon(f.id); this.icons[f.id] = r && ICON_RE.test(r.data || "") ? "data:" + r.data : ""; }
        catch (e) { if (e.code === "bad-reply") this.icons[f.id] = ""; }
      }));
    }
    await this.storage.set({ icons: this.icons });
  }

  async open(id) {
    const it = this.cache.items[id]; if (!it) return null;
    this._evt(it, "open"); this.sessionFeeds.add(it.feedId);
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(); this._notify(); this.flushOps().then(() => this._notify());
    return { url: it.url, feedId: it.feedId };
  }
  async recordDwell(entryId, feedId, ms) {
    if (ms < 1000) return; this.log.append("dwell", { entry: entryId, feed: feedId, payload: { ms: Math.round(ms) } });
    this._derived = null; this._model = null; await this.persist(["events"]); this._notify();
  }
  async toggleSave(id) {
    const it = this.cache.items[id]; if (!it) return;
    it.starred = !it.starred; this._evt(it, it.starred ? "save" : "unsave");
    this.pendingOps = this.pendingOps.filter(o => !(o.op === "bookmark" && o.id === id)); this._queue({ op: "bookmark", id, desired: it.starred });
    let tags = [];
    if (it.starred && this.rd && this.settings.saveToRaindrop) {
      if (this.settings.autoTag) tags = this.suggestTagsFor(id).map(t => t.tag);
      this.rd.save({ link: it.url, title: it.title, tags }).then(() => this._netOk("raindrop")).catch(e => { this._netErr("raindrop", e); this._notify(); });
    }
    await this.persist(); this._notify(); await this.flushOps(); this._notify();
    return { saved: it.starred, tags };
  }
  async dismiss(id) {
    const it = this.cache.items[id]; if (!it) return;
    this._evt(it, "dismiss");
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(); this._notify(); await this.flushOps(); this._notify();
  }
  async undismissAll() {
    const d = this._derive();
    for (const id of d.dismissed) { const it = this.cache.items[id]; this.log.append("undismiss", { entry: id, feed: it && it.feedId }); }
    this._derived = null; this._model = null;
    // Dismissing marked the articles read in Miniflux, so undoing has to bring them back as unread.
    const back = [...d.dismissed].filter(id => this.cache.items[id] && this.cache.items[id].status === "read");
    for (const id of back) this.cache.items[id].status = "unread";
    if (back.length) this._queue({ op: "status", ids: back, status: "unread" });
    await this.persist(); this._notify(); await this.flushOps(); this._notify();
  }
  async train(type, key, value) { this.log.append("train", { payload: { type, key: String(key).toLowerCase(), value } }); this._derived = null; this._model = null; await this.persist(["events"]); this._notify(); }
  trainingRules() { return this._derive().training; }

  // ---------- stats and digest ----------
  stats() {
    const now = this.now(), d = this._derive(), events = this.log.list().filter(e => now - Number(e.ts.split(".")[0]) < 30 * DAY);
    const cat = {}; const meta = this._feedMeta();
    let opens = 0, cards = 0, saves = 0, dismisses = 0, dwellMs = 0;
    for (const e of events) {
      if (e.type === "open") opens++; else if (e.type === "card") cards++; else if (e.type === "dismiss") dismisses++; else if (e.type === "dwell") dwellMs += (e.payload && e.payload.ms) || 0;
      else if (e.type === "save") { saves++; const c = splitCategory((meta[e.feed] && meta[e.feed].category) || "Other")[0]; cat[c] = (cat[c] || 0) + 1; }
    }
    const bands = [[0, .15], [.15, .3], [.3, .45], [.45, 1.01]].map(([lo, hi]) => ({ lo, hi: Math.min(hi, 1), n: 0, opened: 0, saved: 0 }));
    const ctx = this._scoreCtx();
    for (const it of Object.values(this.cache.items)) { const s = this.scoreOne(it, ctx).score; const b = bands.find(x => s >= x.lo && s < x.hi) || bands[3]; b.n++; if (d.opens.has(it.id)) b.opened++; if (it.starred) b.saved++; }
    const league = this.cache.feeds.map(f => ({ id: f.id, title: f.title, authority: authorityOf(d.authorityDelta[f.id] || 0), health: f.health.state }))
      .sort((a, b) => b.authority - a.authority).slice(0, 12);
    return { opens, cards, saves, dismisses, dwellMinutes: Math.round(dwellMs / 60000), savesByFolder: Object.entries(cat).sort((a, b) => b[1] - a[1]), bands, league, pendingHistory: this.pendingHistory };
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
