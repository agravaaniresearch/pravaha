// The engine: owns state, talks to Miniflux, Raindrop and WebDAV, scores items, records events.
// Nothing here touches browser globals directly; the background page injects everything.
import { tokenize, stem, domainOf, firstParagraph, wordCount, canonicalUrl } from "./text.js";
import { Corpus, cosine, mean, prune, topTerms } from "./vector.js";
import { freshHealth, noteWrite, notePoll, healthSummary } from "./health.js";
import { scoreItem, DEFAULT_WEIGHTS, normaliseWeights, whyRanked, feedStanding, standingOf, mixProfile, hotness, exposurePayload } from "./scoring.js";
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
import { loadServer, collector, dueForCheck, noteVersion, setCap, notFound, badFeed, badEntry, badIds, badVersion, ackChange, serverLamp, MIN_VERSION } from "./server.js";

export const STORY_WEIGHT = 0.3;
export const DEFAULT_SETTINGS = {
  device: "", miniflux: { url: "https://reader.miniflux.app", token: "" },
  webdav: { url: "https://myfiles.fastmail.com", user: "", pass: "", root: "pravaha" },
  raindrop: { token: "" }, weights: { ...DEFAULT_WEIGHTS }, pollMinutes: 2, novelty: true,
  palette: "ember", theme: "light", sync: { keys: true, settings: true }, syncMeta: {}, ui: null, retentionDays: 30, autoTag: true, autoDigest: true, saveToRaindrop: false, treeOrder: {}, treeOrderAt: 0, searchKeepDays: 400
};
const DAY = 86400000;
const randomId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const UNREAD_CAP = 3000;
const LIGHT_FETCH_MAX = 40;

const mediaKind = (encs) => { const m = (encs || []).map(x => String(x.mime_type || "")).find(t => /^(audio|video)\//.test(t)); return m ? m.split("/")[0] : null; };
const ICON_RE = /^image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
const BODY_CAP = 150;
const CHUNK = 150;
const INDEX_CAP = 20000;
const VERIFY_ROUNDS = 3;
const RECENT_MS = 10 * 60000;
const RECENT_TRIES = 3;
const QUIET_MS = 1500;

// Storage writes. Small keys are written at once. The three heavy ones (the article copy, the history log and the search index,
// together several megabytes) are written a moment later, together, and only when their content really changed, so an idle poll
// writes nothing at all. Durability does not depend on the delay: changes for Miniflux wait in pendingOps (small, written at once),
// and this machine's newest history lines are written at once as a short tail.
const HEAVY = new Set(["cache", "events", "searchIndex"]);
// 0.8.1 fix: 1.2 s meant one multi-megabyte write per article read. Durability does not need it (pendingOps and the history tail are
// written at once), so the heavy keys wait a minute, and every poll and every unload of the background page writes them anyway.
const DEFER_MS = 60000;
// 0.8.6: read, unread, card and dismiss changes are held and sent to Miniflux together: 30 seconds after the last one, when you leave
// the reader or the Newsfeed, at every poll, and on Sync now. They are saved on this machine at once, so holding them loses nothing.
// Saves, bulk "mark as read" with checking, subscribing and feed changes still go at once.
export const BATCH_MS = 30000;
const FEEDS_EVERY_MS = 15 * 60000;
const cacheJson = (c) => JSON.stringify(c, (k, v) => (k === "lastChangeTs" ? undefined : v)); // the poll cursor lives in "marks"
const hashStr = (str) => { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ":" + str.length; };
const seqOf = (e) => Number(String(e.eid).split(":")[1]) || 0;
const roundBreakdown = (b) => { const o = {}; for (const [k, v] of Object.entries(b || {})) o[k] = typeof v === "number" ? Math.round(v * 1000) / 1000 : v; return o; };
export class Engine {
  constructor({ storage, now = () => Date.now(), fetchImpl, platform = {}, onChange = () => {} }) {
    this.storage = storage; this.now = now; this.fetchImpl = fetchImpl; this.platform = platform; this.onChange = onChange;
    this.sessionFeeds = new Set(); this._settled = new Map(); this._timers = new Set(); this.activity = null; this._muted = false; this._mutedAt = 0; this._heldChange = false; this.searchIndex = {}; this._vecs = new Map(); this._model = null; this._derived = null;
    this._deferred = new Set(); this._deferTimer = null; this._saved = { cache: null, events: null, ownSeq: 0 }; this._base = null;
  }

  // ---------- persistence ----------
  async load() {
    const s = await this.storage.get(["health", "settings", "cache", "events", "eventsTail", "marks", "syncState", "pendingOps", "raindropCache", "echoLocal", "enrichment", "net", "others", "pendingHistory", "bodies", "icons", "searchIndex", "server"]);
    this.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    this.settings.miniflux = { ...DEFAULT_SETTINGS.miniflux, ...(this.settings.miniflux || {}) };
    this.settings.webdav = { ...DEFAULT_SETTINGS.webdav, ...(this.settings.webdav || {}) };
    this.settings.raindrop = { ...DEFAULT_SETTINGS.raindrop, ...(this.settings.raindrop || {}) };
    // 0.8.1: Miniflux's own Raindrop integration now saves articles, so Pravaha's one-way save is switched off once, to avoid duplicates. It can be turned back on.
    if (!this.settings.rdSave081) { this.settings.saveToRaindrop = false; this.settings.rdSave081 = true; await this.storage.set({ settings: this.settings }); }
    this.settings.weights = { ...DEFAULT_WEIGHTS, ...(this.settings.weights || {}) };
    if (!this.settings.treeOrder || typeof this.settings.treeOrder !== "object") this.settings.treeOrder = {};
    this.settings.sync = { ...DEFAULT_SETTINGS.sync, ...(this.settings.sync || {}) }; this.settings.syncMeta = { ...(this.settings.syncMeta || {}) };
    let fresh = false;
    // The old default name was shared by every install, which would make two machines write one log. A machine that has written nothing yet is safe to rename.
    const untouched = !(s.events && s.events.length) && !((s.syncState || {}).pushedSeq);
    if (!this.settings.device || (this.settings.device === "this-machine" && untouched)) { this.settings.device = "browser-" + randomId(5); fresh = true; }
    if (!this.settings.installId) { this.settings.installId = randomId(12); fresh = true; }
    this.cache = { items: {}, feeds: [], lastChangeTs: 0, lastDigestAt: 0, lastDigestTerms: [], ...(s.cache || {}) };
    this.health = { ...freshHealth(), ...(s.health || {}) };
    this.marks = { feedsAt: 0, outboxAt: 0, outboxSig: "", ...(s.marks || {}) };
    if (this.marks.lastChangeTs > (this.cache.lastChangeTs || 0)) this.cache.lastChangeTs = this.marks.lastChangeTs;
    this.pendingOps = (s.pendingOps || []).map(o => ({ ...o, inflight: false })); this.raindropCache = s.raindropCache || null; this.echoLocal = s.echoLocal || null;
    this.enrichment = s.enrichment || {}; this.net = s.net || { miniflux: {}, webdav: {}, raindrop: {} };
    this.searchIndex = s.searchIndex || {}; this.bodies = s.bodies || {}; this.icons = s.icons || {}; this.sessionCards = new Set(); this.others = s.others || {}; this.pendingHistory = s.pendingHistory || [];
    this.log = new EventLog(this.settings.device, new Clock(this.settings.device, this.now));
    this.log.merge(s.events || []);
    this._saved.ownSeq = (s.events || []).reduce((m, e) => (e && e.device === this.settings.device ? Math.max(m, seqOf(e)) : m), 0);
    this.log.merge(s.eventsTail || []);
    this._saved.events = this._eventsSig(); this._saved.cache = s.cache ? hashStr(cacheJson(this.cache)) : null;
    this.syncState = s.syncState || freshSyncState(); this.server = loadServer(s.server);
    this._wire(); this._conn = JSON.stringify([this.settings.miniflux, this.settings.webdav, this.settings.raindrop, this.settings.device]);
    this._invalidate();
    if (fresh) await this.persist(["settings"]);
  }
  _wire() {
    if (!this._countedFetch) { this._reqs = 0; this._countedFetch = (...a) => { this._reqs++; return this.fetchImpl ? this.fetchImpl(...a) : fetch(...a); }; } // the background passes no fetchImpl: use the browser's own
    const fetchImpl = this._countedFetch;
    const w = this.settings.webdav;
    this.dav = w.url && w.user && w.pass ? new WebDav({ baseUrl: w.url, user: w.user, pass: w.pass, fetchImpl }) : null;
    this.syncer = this.dav ? new Syncer({ dav: this.dav, log: this.log, device: this.settings.device, installId: this.settings.installId, root: w.root || "pravaha", now: this.now, state: this.syncState, localExtra: () => ({ echo: this.echoLocal }) }) : null;
    if (this.syncer) this.syncer.onProgress = (p) => { if (p.device) this._act("history", `Reading history from ${p.device}`, p.done, p.total); else this._actEnd("history"); };
    const m = this.settings.miniflux;
    this.mf = m.url && m.token ? new Miniflux({ baseUrl: m.url, token: m.token, fetchImpl }) : null;
    this.rd = this.settings.raindrop.token ? new Raindrop({ token: this.settings.raindrop.token, fetchImpl }) : null;
  }
  _eventsSig() { return this.log.count() + "|" + (this.log.head() || ""); }
  // Writes the small keys now and schedules the heavy ones. With no list, everything is written (only first-time setup and imports do that).
  async persist(keys, { immediate = false } = {}) {
    const all = { health: this.health, settings: this.settings, syncState: this.syncState, pendingOps: this.pendingOps, raindropCache: this.raindropCache, echoLocal: this.echoLocal, enrichment: this.enrichment, net: this.net, others: this.others, pendingHistory: this.pendingHistory, server: this.server, marks: this.marks };
    const list = keys || [...Object.keys(all), ...HEAVY];
    const out = {}; let heavy = false;
    for (const k of list) {
      if (HEAVY.has(k)) { this._deferred.add(k); heavy = true; continue; }
      if (k in all) out[k] = all[k];
    }
    if (this._deferred.has("events")) { const tail = this.log.own().filter(e => seqOf(e) > this._saved.ownSeq); if (tail.length || keys === undefined) out.eventsTail = tail; }
    if (Object.keys(out).length) { noteWrite(this.health, this.now(), JSON.stringify(out).length, false); await this.storage.set(out); }
    if (heavy) { if (immediate || !keys) await this.flushPersist(); else this._scheduleFlush(); }
  }
  _scheduleFlush() {
    if (this._deferTimer) return;
    this._deferTimer = setTimeout(() => { this._deferTimer = null; this.flushPersist().catch(() => {}); }, DEFER_MS);
    if (this._deferTimer && this._deferTimer.unref) this._deferTimer.unref();
  }
  // Writes the heavy keys that were asked for, skipping any whose content is the same as the last write.
  async flushPersist() {
    if (this._deferTimer) { clearTimeout(this._deferTimer); this._deferTimer = null; }
    const want = [...this._deferred]; this._deferred.clear(); const out = {};
    let bytes = 0;
    if (want.includes("cache")) { const h = hashStr(cacheJson(this.cache)); if (h !== this._saved.cache) { out.cache = this.cache; this._saved.cache = h; bytes += Number(h.split(":")[1]) || 0; } }
    if (want.includes("events")) { const sig = this._eventsSig(); if (sig !== this._saved.events) { out.events = this.log.list(); out.eventsTail = []; this._saved.events = sig; this._saved.ownSeq = this.log.seq; } }
    if (want.includes("searchIndex") && this._idxDirty) { out.searchIndex = this.searchIndex; this._idxDirty = false; }
    if (Object.keys(out).length) {
      for (const k of Object.keys(out)) if (k !== "cache") bytes += JSON.stringify(out[k]).length;
      noteWrite(this.health, this.now(), bytes, true); this._pollHeavy = true; await this.storage.set(out);
    }
    return Object.keys(out);
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
      this.syncState = freshSyncState(); this._saved.ownSeq = 0; this._saved.events = null;
    }
    // Only a change of connection or machine name rebuilds the clients; a theme or order change keeps them (and their learned shortcuts).
    const conn = JSON.stringify([this.settings.miniflux, this.settings.webdav, this.settings.raindrop, this.settings.device]);
    if (conn !== this._conn) { this._conn = conn; this._wire(); }
    if (patch.raindrop || this.settings.device !== prevDevice) this._invalidate();
    await this.persist(this.settings.device !== prevDevice ? ["settings", "syncState", "events"] : ["settings"], { immediate: true }); this._notify();
  }
  // _invalidate: the vocabulary may have changed (new Raindrop copy, new echo, settings), so everything derived from text is rebuilt.
  _invalidate() { this._base = null; this._model = null; this._derived = null; this._hot = null; this._vecs.clear(); }

  // ---------- model ----------
  _derive() {
    if (!this._derived) {
      const own = this.log.list(), extra = this._raindropSaves(own), now = this.now();
      const ev = extra.length ? [...own, ...extra].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) : own;
      this._derived = derive(ev, now); this._derived.standing = feedStanding(ev, now);
    }
    return this._derived;
  }
  // Articles Miniflux saved to your "MiniFlux Saves" Raindrop collection count as saves for ranking: they pull the interest profile and
  // raise the feed's standing. They are worked out, never logged, so nothing new travels between machines, and an article you also
  // saved in Pravaha counts once.
  _raindropSaves(own) {
    const rc = this.raindropCache; this._rdMatch = { matched: 0, count: 0 };
    if (!rc || !rc.mfColl) return [];
    const inColl = (rc.bookmarks || []).filter(b => b.coll === rc.mfColl.id); this._rdMatch.count = inColl.length;
    if (!inColl.length) return [];
    const byUrl = new Map(); for (const it of Object.values(this.cache.items)) { const c = canonicalUrl(it.url); if (c) byUrl.set(c, it); }
    const saved = new Set(own.filter(e => e.type === "save" || e.type === "unsave").map(e => String(e.entry)));
    const out = [];
    for (const b of inColl) {
      const it = byUrl.get(canonicalUrl(b.link)); if (!it) continue; this._rdMatch.matched++;
      if (saved.has(String(it.id))) continue;
      const at = Math.min(b.at || this.now(), this.now());
      out.push({ v: 1, eid: `raindrop:${it.id}`, device: "raindrop", ts: `${String(at).padStart(14, "0")}.00000.raindrop`, type: "save", entry: it.id, feed: it.feedId, payload: { terms: [...new Set(tokenize(`${it.title} ${it.summary}`))].slice(0, 12) } });
    }
    return out;
  }
  // The expensive part (vocabulary, one vector per Raindrop save, tag profiles) is built once per Raindrop copy.
  // The interest profile and the echo are cheap and are rebuilt whenever the history changes.
  _buildBase() {
    if (this._base) return this._base;
    if (this.health) this.health.rebuilds = (this.health.rebuilds || 0) + 1;
    const bms = (this.raindropCache && this.raindropCache.bookmarks) || [];
    const corpus = new Corpus();
    const text = (b) => `${(b.tags || []).join(" ")} ${(b.tags || []).join(" ")} ${b.note || ""} ${b.title || ""} ${b.excerpt || ""}`;
    const toks = bms.map(b => tokenize(text(b)));
    for (const t of toks) corpus.add(t);
    const fromItems = corpus.n < 20; // too few saves for a vocabulary of their own: borrow the articles, and rebuild after each refresh
    if (fromItems) for (const it of Object.values(this.cache.items)) corpus.add(tokenize(`${it.title} ${it.summary}`));
    const now = this.now();
    const vecs = toks.map(t => corpus.vector(t));
    const weights = bms.map(b => Math.pow(0.5, Math.max(0, now - (b.at || now)) / (365 * DAY)));
    const bmByUrl = new Map(); bms.forEach((b, i) => { const c = canonicalUrl(b.link); if (c && !bmByUrl.has(c)) bmByUrl.set(c, i); });
    this._base = { corpus, fromItems, baseCentroid: prune(mean(vecs, weights), 500), profiles: buildTagProfiles(bms, corpus), bms, bmVecs: vecs, bmByUrl, pullVecs: new Map() };
    return this._base;
  }
  _buildModel() {
    if (this._model) return this._model;
    const b = this._buildBase(); const corpus = b.corpus;
    // The interest profile: your Raindrop saves, plus what you opened, saved and thumbed up, which can never take more than 30 percent of it
    // and fades with a 60-day half life. (0.7.0 blended each action in turn, so a hundred opens erased the saves.)
    const d = this._derive();
    const pv = (terms) => { const k = terms.join(" "); let v = b.pullVecs.get(k); if (!v) { v = corpus.vector(terms); b.pullVecs.set(k, v); } return v; };
    const centroid = mixProfile(b.baseCentroid, d.pulls.filter(p => Array.isArray(p.terms)).map(p => ({ kind: p.kind, at: p.at, vec: pv(p.terms) })), this.now());
    const echo = this._echoMerged(corpus);
    this._model = { ...b, centroid, echo: echo.vec, domainVisits: echo.domainVisits };
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
  // Article vectors are kept between refreshes and rebuilt only when the article's text changed (or the vocabulary did, which clears them all).
  _itemVec(it) {
    const sig = `${it.title}|${(it.summary || "").length}|${(it.tags || []).join(",")}|${it.url}`;
    let v = this._vecs.get(it.id); if (v && v.sig !== sig) v = null;
    if (!v) { const m = this._buildModel(); const vec = m.corpus.vector(tokenize(`${it.title} ${it.title} ${it.summary}`)); v = { vec, stems: topTerms(vec, 12), sig }; this._vecs.set(it.id, v); if (this._vecs.size > 2 * Object.keys(this.cache.items).length + 500) this._pruneVecs(); }
    return v;
  }
  _pruneVecs() { for (const id of this._vecs.keys()) if (!this.cache.items[id]) this._vecs.delete(id); }
  _scoreCtx() {
    const m = this._buildModel(), d = this._derive();
    return { weights: this.settings.weights, centroid: m.centroid, echo: m.echo, domainVisits: m.domainVisits, authorityDelta: d.authorityDelta, standing: d.standing, profiles: m.profiles, hot: this._hotMap(),
      training: d.training, story: d.story, tagRules: d.training.some(r => r.type === "tag"), now: this.now(), sessionFeeds: this.sessionFeeds, novelty: this.settings.novelty, enrichment: this.enrichment };
  }
  // Fever-style heat: the same story carried by several feeds within a day and a half. Worked out once per refresh over the recent articles.
  _hotMap() {
    if (this._hot) return this._hot;
    const cut = this.now() - 3 * DAY; const list = [];
    for (const it of Object.values(this.cache.items)) if (it.publishedAt > cut) { const v = this._itemVec(it); list.push({ id: it.id, feedId: it.feedId, publishedAt: it.publishedAt, vec: v.vec, stems: v.stems }); }
    this._hot = hotness(list); return this._hot;
  }
  scoreOne(it, ctx = this._scoreCtx()) {
    const v = this._itemVec(it);
    return scoreItem({ id: it.id, feedId: it.feedId, vec: v.vec, stems: v.stems, domain: it.domain, publishedAt: it.publishedAt, seenAt: it.seenAt, author: it.author, tags: ctx.tagRules ? this._itemTags(it) : it.tags }, ctx);
  }
  // The tags a tag rule can match: the ones the feed sent, the tags of your own Raindrop save of this very page, and the tags suggested from your Raindrop vocabulary.
  // Worked out only while at least one tag rule exists, and kept per article until the next refresh.
  _itemTags(it) {
    const v = this._itemVec(it); if (v.tags) return v.tags;
    const m = this._buildModel(); const set = new Set((it.tags || []).map(t => String(t).toLowerCase()));
    const own = this._savedCopy(it, m); if (own) for (const t of own.tags || []) set.add(String(t).toLowerCase());
    for (const t of suggestTags(v.vec, v.stems, m.profiles)) set.add(t.tag.toLowerCase());
    v.tags = [...set]; return v.tags;
  }
  _savedCopy(it, m = this._buildModel()) { const c = canonicalUrl(it.url); const i = c ? m.bmByUrl.get(c) : undefined; return i === undefined ? null : m.bms[i]; }

  // ---------- Miniflux ----------
  _norm(e, prev = {}) {
    const feed = e.feed || {};
    return { ...prev, id: e.id, feedId: e.feed_id || feed.id, feedTitle: feed.title || prev.feedTitle || "Unknown feed",
      category: (feed.category && feed.category.title) || prev.category || "Uncategorised",
      title: e.title || "(untitled)", summary: firstParagraph(e.content, 320), publishedAt: Date.parse(e.published_at) || prev.publishedAt || 0, seenAt: Date.parse(e.created_at) || prev.seenAt || 0,
      author: e.author || null, url: e.url, domain: domainOf(e.url), tags: e.tags || [], status: e.status, starred: !!e.starred, readingTime: e.reading_time || 0,
      words: e.content ? wordCount(e.content) : (prev.words || 0), thumb: (/<img[^>]+src=["'](https:\/\/[^"']{1,300})["']/i.exec(e.content || "") || [])[1] || prev.thumb || null,
      media: mediaKind(e.enclosures) || prev.media || null, comments: e.comments_url || prev.comments || null };
  }
  _pendingIds() { const s = new Set(); for (const o of this.pendingOps) { if (o.op === "status") o.ids.forEach(i => s.add(i)); else s.add(o.id); } return s; }

  // One flush at a time. An op that is being sent is marked in flight, so a later change can never be
  // merged into it and then dropped when it completes.
  async _sendLater() {
    if (!this.mf || !this.pendingOps.length) return;
    const ms = this.batchMs ?? (globalThis.PRAVAHA_BATCH_MS ?? BATCH_MS); // the older tests set 0: send at once, as before 0.8.6
    if (!ms) { await this.flushOps(); this._notify(); return; }
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._batchTimer = setTimeout(() => { this._batchTimer = null; this.flushOps().then(() => this._notify()).catch(() => {}); }, ms);
    if (this._batchTimer.unref) this._batchTimer.unref();
  }
  // Send whatever is held now (leaving the page, Sync now, Firefox unloading the background).
  sendHeld() { if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; } return this.flushOps().then(() => this._notify()); }
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

  // ---------- refresh: ids first, bodies only for what is new ----------
  // Reads the version now and then, and whenever the last refresh found something Pravaha did not understand.
  async _checkServer() {
    if (!dueForCheck(this.server, this.now())) return;
    try {
      const v = await this.mf.version(); const bad = badVersion(v);
      if (bad) { setCap(this.server, "version", false); this.server.checkedAt = this.now(); } else noteVersion(this.server, v.version, this.now());
    } catch (e) { if (notFound(e)) { setCap(this.server, "version", false); this.server.checkedAt = this.now(); } else if (e && e.code === "auth") throw e; /* a failed version check never stops a refresh */ }
  }
  _applyFeeds(feeds, col) {
    const ok = []; for (const f of feeds || []) { const bad = badFeed(f); if (bad) col.note("feeds", bad); else ok.push(f); }
    this.cache.feeds = ok.map(f => ({ id: f.id, title: f.title, category: (f.category && f.category.title) || "Uncategorised", health: feedHealth(f, this.now()), siteUrl: f.site_url || "", feedUrl: f.feed_url || "", iconId: f.icon ? f.icon.icon_id : null, checkedAt: f.checked_at || null, disabled: !!f.disabled, errors: f.parsing_error_count || 0, errorText: f.parsing_error_message ? String(f.parsing_error_message).slice(0, 200) : "" }));
  }
  _takeEntry(e, col, prev) { const bad = badEntry(e); if (bad) { col.note("articles", bad); return false; } this.cache.items[e.id] = this._norm(e, prev); return true; }
  // The full download: every unread article body, up to the cap. Used when the list of entry numbers is not available or cannot be trusted.
  async _pullUnreadFull(pend, col) {
    const un = await this.mf.allUnread(UNREAD_CAP);
    const capped = un.entries.length >= UNREAD_CAP && un.total > un.entries.length;
    const serverIds = new Set(); const recent = this.cache.recent; const resend = [];
    for (const e of un.entries) {
      if (badEntry(e)) { col.note("articles", badEntry(e)); continue; }
      serverIds.add(e.id); if (pend.has(e.id)) continue; const cur = this.cache.items[e.id];
      if (cur && cur.status === "read" && recent[e.id]) { recent[e.id].n++; resend.push(e.id); continue; }
      this.cache.items[e.id] = this._norm(e, cur);
    }
    if (resend.length) this._queue({ op: "status", ids: resend, status: "read" });
    if (!capped) for (const it of Object.values(this.cache.items)) if (it.status === "unread" && !serverIds.has(it.id) && !pend.has(it.id)) it.status = "read";
  }
  // The light pull. Returns false when it cannot be done safely, and the caller then runs the full download instead.
  async _pullUnreadLight(pend, col) {
    const have = this.cache.items; if (!Object.keys(have).length) return false;
    let r;
    try { r = await this.mf.entryIds({ status: "unread", limit: 10000 }); }
    catch (e) { if (notFound(e)) { setCap(this.server, "entryIds", false); return false; } throw e; }
    const bad = badIds(r); if (bad) { col.note("entry numbers", bad); setCap(this.server, "entryIds", false); return false; }
    setCap(this.server, "entryIds", true);
    const ids = r.entry_ids; if (r.total > ids.length) return false;
    const idSet = new Set(ids); let maxId = 0; for (const k of Object.keys(have)) if (+k > maxId) maxId = +k;
    const missing = ids.filter(id => !have[id] && !pend.has(id)); const newer = missing.filter(id => id > maxId); const older = missing.filter(id => id <= maxId);
    if (older.length > LIGHT_FETCH_MAX || newer.length > UNREAD_CAP) return false;
    if (newer.length) {
      if (this.server.caps.afterEntryId === false) return false;
      let cursor = maxId; const want = new Set(newer);
      for (let guard = 0; guard < 20 && want.size; guard++) {
        let page;
        try { page = await this.mf.entries({ status: "unread", after_entry_id: cursor, order: "id", direction: "asc", limit: 250 }); }
        catch (e) { if (notFound(e)) { setCap(this.server, "afterEntryId", false); return false; } throw e; }
        const es = (page && page.entries) || []; setCap(this.server, "afterEntryId", true);
        for (const e of es) { want.delete(e.id); if (!pend.has(e.id) && e.status === "unread") this._takeEntry(e, col, have[e.id]); cursor = Math.max(cursor, Number(e.id) || 0); }
        if (es.length < 250) break;
      }
    }
    for (const id of older) { try { const e = await this.mf.entry(id); if (e && e.status === "unread") this._takeEntry(e, col, have[id]); } catch (e) { if (e && e.code !== "rejected" && e.code !== "bad-reply") throw e; } }
    // The same rules as the full download, with entry numbers in place of bodies: it was sent here a moment ago and is still unread there, so send it again.
    const recent = this.cache.recent; const resend = [];
    for (const id of ids) {
      const cur = have[id]; if (!cur || pend.has(id)) continue;
      if (cur.status === "read" && recent[id]) { recent[id].n++; resend.push(id); } else if (cur.status !== "unread") cur.status = "unread";
    }
    if (resend.length) this._queue({ op: "status", ids: resend, status: "read" });
    for (const it of Object.values(have)) if (it.status === "unread" && !idSet.has(it.id) && !pend.has(it.id)) it.status = "read";
    return true;
  }
  async _pullStars(pend, col) {
    if (this.server.caps.entryIds !== false) {
      try {
        const r = await this.mf.entryIds({ starred: "true", limit: 10000 }); const bad = badIds(r);
        if (!bad && r.total <= r.entry_ids.length) {
          const star = new Set(r.entry_ids); const have = this.cache.items; const miss = r.entry_ids.filter(id => !have[id] && !pend.has(id));
          if (miss.length <= LIGHT_FETCH_MAX) {
            for (const id of miss) { try { const e = await this.mf.entry(id); this._takeEntry(e, col, undefined); } catch (e) { if (e && e.code !== "rejected" && e.code !== "bad-reply") throw e; } }
            for (const it of Object.values(have)) { if (pend.has(it.id)) continue; if (star.has(it.id)) it.starred = true; else if (it.starred) it.starred = false; }
            return;
          }
        } else if (bad) col.note("entry numbers", bad);
      } catch (e) { if (!notFound(e)) throw e; setCap(this.server, "entryIds", false); }
    }
    const starred = await this.mf.entries({ starred: "true", limit: 250, order: "published_at", direction: "desc" });
    const starIds = new Set();
    for (const e of starred.entries || []) { if (badEntry(e)) { col.note("articles", badEntry(e)); continue; } starIds.add(e.id); if (pend.has(e.id)) continue; this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
    if ((starred.entries || []).length < 250) for (const it of Object.values(this.cache.items)) if (it.starred && !starIds.has(it.id) && !pend.has(it.id)) it.starred = false;
  }

  // The feed list (names, folders, health) changes rarely and is the largest routine answer, so a quiet poll reads it every fifteen minutes,
  // and at once when an article names a feed this machine does not know yet.
  _feedsDue(force) { return force || !this.cache.feeds.length || this.now() - (this.marks.feedsAt || 0) > FEEDS_EVERY_MS; }
  async refresh({ feeds = false } = {}) {
    if (!this.mf) return;
    const col = collector(); this.mf.stats.calls = 0; this.mf.stats.bytes = 0; let mode = "full";
    try {
      await this.flushOps();
      const t0 = this.now(); this._act("pull", "Reading from Miniflux");
      await this._checkServer();
      if (this._feedsDue(feeds)) { this._applyFeeds(await this.mf.feeds(), col); this.marks.feedsAt = this.now(); }
      // Anything we sent while this fetch was running may be missing from the snapshot, so it counts as pending too.
      const pend = this._pendingIds(); for (const [id, t] of this._settled) if (t > t0) pend.add(id);
      const recent = this.cache.recent || (this.cache.recent = {}); for (const id of Object.keys(recent)) if (this.now() - recent[id].t > RECENT_MS || recent[id].n >= RECENT_TRIES) delete recent[id];
      let light = false;
      if (this.server.caps.entryIds !== false) light = await this._pullUnreadLight(pend, col);
      if (light) mode = "light"; else await this._pullUnreadFull(pend, col);
      await this._pullStars(pend, col);
      // The light pull already reconciles read and saved state by number, so the "changed since" download (full article bodies) is needed only after a full one.
      if (this.cache.lastChangeTs && !light) {
        for (const e of await this.mf.changedSince(this.cache.lastChangeTs)) { if (pend.has(e.id)) continue; if (badEntry(e)) { col.note("articles", badEntry(e)); continue; } if (this.cache.items[e.id] || e.status === "unread") this.cache.items[e.id] = this._norm(e, this.cache.items[e.id]); }
      }
      this.cache.lastChangeTs = Math.floor(this.now() / 1000) - 5; this.marks.lastChangeTs = this.cache.lastChangeTs;
      const known = new Set(this.cache.feeds.map(f => f.id)); if (Object.values(this.cache.items).some(it => it.status === "unread" && !known.has(it.feedId))) { this._applyFeeds(await this.mf.feeds(), col); this.marks.feedsAt = this.now(); }
      this._retain(); this._reindex();
      if (this.pendingOps.length) await this.flushOps();
      this._netOk("miniflux"); this._hot = null; if (this.raindropCache && this.raindropCache.mfColl) { this._derived = null; this._model = null; } // new articles may match Raindrop saves if (this._base && this._base.fromItems) this._invalidate();
      this.net.miniflux = { ...this.net.miniflux, mode, calls: this.mf.stats.calls, bytes: this.mf.stats.bytes };
    } catch (e) { this._netErr("miniflux", e); }
    col.done(this.server, this.now()); this._actEnd("pull");
    await this.persist(["cache", "net", "pendingOps", "searchIndex", "server", "marks"]);
  }
  _retain() {
    const cut = this.now() - this.settings.retentionDays * DAY; const d = this._derive();
    for (const it of Object.values(this.cache.items))
      if (it.status === "read" && !it.starred && !d.opens.has(it.id) && !d.cards.has(it.id) && it.publishedAt < cut) delete this.cache.items[it.id];
  }

  // Once a day, how many articles each feed published on each of the last few whole days (UTC), as a "calibration" event.
  // Feed standing divides what you engaged with by this, so a feed that publishes a hundred a day cannot rank on volume.
  // Two machines may log the same day; standing takes the larger count per feed and day, so the result does not depend on who logged it.
  _logExposure() {
    if (!this.mf || !this.cache.feeds.length) return;
    const today = Math.floor(this.now() / DAY) * DAY; const last = this.marks.exposureDay || 0; let wrote = false;
    for (let d = Math.max(last + DAY, today - 3 * DAY); d < today; d += DAY) {
      const p = exposurePayload(Object.values(this.cache.items), d); if (p && Object.keys(p.feeds).length) { this.log.append("calibration", { payload: p }); wrote = true; }
    }
    if (last < today - DAY || !last) this.marks.exposureDay = today - DAY;
    if (wrote) { this._derived = null; this._model = null; this.persist(["events", "marks"]).catch(() => {}); }
  }

  // ---------- Raindrop and echo ----------
  async refreshRaindrop(force = false) {
    if (!this.rd) return;
    if (!force && this.raindropCache && this.raindropCache.v === 3 && this.now() - this.raindropCache.at < DAY) return;
    try {
      const bms = await this.rd.bookmarks();
      let mfColl = null; try { const c = (await this.rd.collections()).find(x => /^\s*miniflux\s*saves\s*$/i.test(x.title)); if (c) mfColl = { id: c.id, title: c.title }; } catch { /* the collection list is optional */ }
      this.raindropCache = { at: this.now(), v: 3, mfColl, bookmarks: bms.map(({ title, excerpt, note, tags, domain, at, link, coll }) => ({ title, excerpt, note, tags, domain, at, link, coll })) };
      this._netOk("raindrop"); this._invalidate();
    } catch (e) { this._netErr("raindrop", e); }
    await this.persist(["raindropCache", "net"]);
  }
  async refreshEcho(force = false) {
    if (!this.platform.echoDocs) return;
    if (!force && this.echoLocal && this.now() - this.echoLocal.at < DAY) return;
    // Pages you opened from Pravaha already count through standing and the profile, so they are left out here (counted once, not three times).
    const mine = new Set(); const d0 = this._derive(); for (const id of d0.opens.keys()) { const it = this.cache.items[id]; if (it) mine.add(canonicalUrl(it.url)); }
    const docs = (await this.platform.echoDocs(90)).filter(x => !mine.has(canonicalUrl(x.url))); // [{title,url,visits}]
    const corpus = this._buildModel().corpus; const domainCounts = {}; const vecs = [], w = [];
    for (const d of docs) {
      const dom = domainOf(d.url); if (dom) domainCounts[dom] = (domainCounts[dom] || 0) + (d.visits || 1);
      const t = tokenize(d.title); if (t.length) { vecs.push(corpus.vector(t)); w.push(1 + Math.log(1 + (d.visits || 1))); }
    }
    this.echoLocal = { at: this.now(), vec: prune(mean(vecs, w), 300), domainCounts };
    this._model = null; await this.persist(["echoLocal"]);
  }

  // ---------- sync ----------
  async syncNow({ quiet = false } = {}) {
    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; } // a poll sends whatever is held
    const before = quiet ? this.signature() : null;
    const t0 = this.now(), w0 = this.health.writes.length ? this.health.writes[this.health.writes.length - 1][0] : 0, r0 = this._reqs || 0; this._pollHeavy = false; const p0 = performance.now(); const owed = this._deferred.size > 0; // your own reading left writes waiting: not the poll's doing
    if (quiet) { this._muted = true; this._mutedAt = this.now(); this._heldChange = false; }
    try {
      await this.refresh({ feeds: !quiet });
      this._logExposure();
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
        if (r.ok) {
          this._netOk("webdav");
          const echoSig = (o) => hashStr(JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k] && o[k].echo])));
          if (echoSig(r.others) !== echoSig(this.others)) this._model = null;
          this.others = r.others; if (r.pulled > 0) { this._derived = null; this._model = null; }
          await this._enrich(); await this._autoDigest();
        }
        else this._netErr("webdav", new PlainError(r.error.plain, r.error.code));
        this.nameClash = this.syncer.nameClash || null;
        this.pendingHistory.push({ at: this.now(), pending: this.syncer.pending().length }); this.pendingHistory = this.pendingHistory.slice(-120);
      }
      // The heavy keys first, then the sync record that says which remote history was applied, so a crash in between can only cause a re-read, never a loss.
      this._deferred.add("cache"); this._deferred.add("events"); this._deferred.add("searchIndex"); await this.flushPersist();
      const bytes = this.health.writes.filter(x => x[0] >= t0 && x[0] >= w0).reduce((a, x) => a + x[1], 0);
      notePoll(this.health, { at: t0, ms: Math.round(performance.now() - p0), reqs: (this._reqs || 0) - r0, bytes, heavy: this._pollHeavy, changed: !quiet || owed || before !== this.signature() });
      await this.persist(["syncState", "others", "pendingHistory", "net", "enrichment", "marks", "pendingOps", "server", "health"]);
    } finally {
      const announce = !quiet || !this._muted || this.signature() !== before; this._muted = false; this._heldChange = false;
      if (announce) this.onChange();
    }
  }
  // The outside-scoring files are read and written at most once an hour, and the outbox only when its list of articles changed.
  async _enrich() {
    if (this.now() - (this.marks.outboxAt || 0) < 3600000) return;
    try {
      const root = this.settings.webdav.root || "pravaha";
      const res = await this.dav.get(`${root}/enrich/results.json`);
      if (res) this.enrichment = parseResults(res).map;
      const scored = this._unreadScored();
      const box = buildOutbox({ items: scored.map(s => ({ ...s.it, score: s.s.score })), centroidTerms: topTerms(this._buildModel().centroid, 30), now: this.now() });
      const sig = hashStr(JSON.stringify(box.items.map(i => i.id)));
      if (sig !== this.marks.outboxSig) { await this.dav.put(`${root}/enrich/outbox.json`, JSON.stringify(box, null, 1)); this.marks.outboxSig = sig; }
      this.marks.outboxAt = this.now();
    } catch { /* enrichment is optional; failures here must not mark the sync as failed */ }
  }
  async _autoDigest() { if (this.settings.autoDigest && this.now() - this.cache.lastDigestAt > DAY) await this.writeDigest().catch(() => {}); }

  status() {
    const feeds = this.cache.feeds || [];
    return { server: { version: this.server.version, changed: this.server.changed, caps: this.server.caps, contract: this.server.contract, mode: (this.net.miniflux && this.net.miniflux.mode) || null, calls: (this.net.miniflux && this.net.miniflux.calls) || 0, bytes: (this.net.miniflux && this.net.miniflux.bytes) || 0 }, activity: this._visibleActivity(), imported: this.imported || null, nameClash: this.nameClash || null, pendingCount: this._remaining(), ...computeStatus({
      now: this.now(), device: this.settings.device, myHead: this.log.headOf(this.settings.device), remoteHeads: this.syncState.remoteHeads, others: this.others,
      miniflux: { configured: !!this.mf, error: this.net.miniflux && this.net.miniflux.error, lastOkAt: this.net.miniflux && this.net.miniflux.lastOkAt },
      webdav: { configured: !!this.dav, error: this.net.webdav && this.net.webdav.error, lastOkAt: this.net.webdav && this.net.webdav.lastOkAt },
      raindrop: { configured: !!this.rd, error: this.net.raindrop && this.net.raindrop.error, lastOkAt: this.net.raindrop && this.net.raindrop.lastOkAt, mfColl: this.raindropCache && this.raindropCache.mfColl ? { title: this.raindropCache.mfColl.title, ...(this._derive(), this._rdMatch) } : null },
      health: healthSummary(this.health, this.now(), { events: this.log.count(), bytesInUse: this.bytesInUse || null }),
      serverLamp: serverLamp(this.server, !!this.mf, this.now()), eventCounts: this.log.countsByDevice(), pendingOps: this.pendingOps.reduce((n, o) => n + (o.ids ? o.ids.length : 1), 0), held: !!this._batchTimer, pendingEvents: this.syncer ? this.syncer.pending().length : this.log.own().length, corruptLines: this.syncState.corruptLines,
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
      const list = kids.get(key) || []; const ord = new Map((Array.isArray(saved[key]) ? saved[key] : []).map((id, i) => [id, i]));
      const rank = (n) => (ord.has(n.id) ? ord.get(n.id) : 1e6);
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
    await this.persist(["events"]); // the history copy of the order must be saved too, or it is lost when Firefox unloads the background page
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
    // A publish date later than when Miniflux first stored the article is not trusted for display or order either.
    const at = it.seenAt && it.publishedAt > it.seenAt + 7200000 ? it.seenAt : it.publishedAt;
    return { id: it.id, feedId: it.feedId, feedTitle: it.feedTitle, title: it.title, summary: it.summary, url: it.url, publishedAt: at, read: it.status === "read", saved: it.starred,
      score: s.score, why: whyRanked(s.breakdown), breakdown: roundBreakdown(s.breakdown), flag: s.flag, author: it.author, readingTime: it.readingTime, dead: dead.has(it.feedId), domain: it.domain, tags: it.tags || [], words: it.words || 0, thumb: it.thumb || null, media: it.media || null, comments: it.comments || null, newish: at > this.now() - 3 * 3600000, pending: !!(pend && pend.has(it.id)), rating: (ctx.story[String(it.id)] || {}).value || 0 };
  }
  getView({ scope = "all", mode = "unread", ranked = false, q = "", keep = [] } = {}, tree = null) {
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
      const pos = new Map(); (tree || this.tree()).forEach((n, i) => pos.set(n.id, i));
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
    const wantVerify = verify === undefined ? ids.length >= 25 : verify;
    this._queue({ op: "status", ids: [...ids], status: "read" }); await this.persist(["cache", "events", "pendingOps"]); this._notify();
    if (wantVerify) { await this.sendHeld(); } else await this._sendLater();
    const res = { count: ids.length, changed, ids: flipped, verified: false, retried: 0, failed: 0, pending: this._remaining() };
    if (wantVerify) Object.assign(res, await this._verifyRead(ids));
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
    this._queue({ op: "status", ids: [...ids], status: "unread" }); await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this._sendLater();
    return { count: ids.length, pending: this._remaining() };
  }
  // The reader opened the article as an in-page card. A light positive signal, logged once per session.
  async openCard(id) {
    const it = this.cache.items[id]; if (!it) return;
    if (!this.sessionCards.has(id)) { this.sessionCards.add(id); this._evt(it, "card"); }
    this.sessionFeeds.add(it.feedId);
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this._sendLater();
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
      await this.refresh({ feeds: true });
      const f = this.cache.feeds.find(x => x.id === r.feed_id);
      return { ok: true, feedId: r.feed_id, title: f ? f.title : "the feed", sentence: `Subscribed to ${f ? f.title : "the feed"}.` };
    } catch (e) { this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "Subscribing failed for an unexpected reason." }; }
    finally { this._actEnd("subscribe"); }
  }

  // ---------- the server record, and managing feeds ----------
  // These calls change the server, so they are never queued: if Miniflux cannot be reached the action fails with a sentence and nothing changes here.
  async serverAck() { ackChange(this.server); await this.persist(["server"]); this._notify(); return this.status(); }
  // A read-only self-test the reader can run on demand. It changes no article and no feed.
  async serverCheck() {
    if (!this.mf) return { ok: false, lines: [{ state: "off", text: "Miniflux is not set up yet." }], status: this.status() };
    const lines = []; const col = collector(); const L = (state, text) => lines.push({ state, text }); this._act("check", "Checking Miniflux");
    const probe = async (name, fn) => { try { return await fn(); } catch (e) { if (e && e.code === "auth") throw e; if (notFound(e)) return { __missing: true }; L("amber", `${name}: ${e instanceof PlainError ? e.plain : "the call failed for an unexpected reason."}`); return { __failed: true }; } };
    try {
      const v = await probe("Version", () => this.mf.version());
      if (v && v.__missing) { setCap(this.server, "version", false); this.server.checkedAt = this.now(); L("amber", `Version: this server does not report one (older than ${MIN_VERSION.version}, or something in front of it hides the page).`); }
      else if (v && !v.__failed) { const bad = badVersion(v); if (bad) { col.note("version", bad); L("red", "Version: the answer had no version number."); } else { noteVersion(this.server, v.version, this.now()); L("green", `Version: Miniflux ${v.version}.`); } }
      const ids = await probe("Entry numbers", () => this.mf.entryIds({ status: "unread", limit: 1 }));
      if (ids && ids.__missing) { setCap(this.server, "entryIds", false); L("amber", `Entry numbers: not offered (needs Miniflux ${MIN_VERSION.entryIds} or newer). Refreshes download every unread article instead.`); }
      else if (ids && !ids.__failed) { const bad = badIds(ids); if (bad) { col.note("entry numbers", bad); setCap(this.server, "entryIds", false); L("red", `Entry numbers: the answer had no usable "${bad}".`); } else { setCap(this.server, "entryIds", true); L("green", `Entry numbers: working (${ids.total} unread). Refreshes download only what is new.`); } }
      const aft = await probe("New articles", () => this.mf.entries({ status: "unread", after_entry_id: 0, order: "id", direction: "asc", limit: 1 }));
      if (aft && aft.__missing) { setCap(this.server, "afterEntryId", false); L("amber", "New articles: this server ignores the position marker, so refreshes download every unread article."); }
      else if (aft && !aft.__failed) { const e = (aft.entries || [])[0]; const bad = e ? badEntry(e) : null; if (bad) { col.note("articles", bad); L("red", `New articles: an article had no usable "${bad}".`); } else { setCap(this.server, "afterEntryId", true); L("green", "New articles: working."); } }
      const fs = await probe("Feeds", () => this.mf.feeds());
      if (Array.isArray(fs)) { const bad = fs.map(badFeed).find(Boolean); if (bad) { col.note("feeds", bad); L("red", `Feeds: a feed had no usable "${bad}".`); } else L("green", `Feeds: ${fs.length} read.`); }
      L("off", "Refreshing one folder is not tried here, because it would make Miniflux fetch feeds. It is checked the first time you use it.");
      col.done(this.server, this.now());
    } catch (e) { L("red", e instanceof PlainError ? e.plain : "The check stopped for an unexpected reason."); }
    finally { this._actEnd("check"); }
    await this.persist(["server"]); this._notify();
    return { ok: !lines.some(l => l.state === "red"), lines, status: this.status() };
  }
  feedsInfo() {
    return this.cache.feeds.map(f => ({ id: f.id, title: f.title, category: f.category, state: f.health.state, sentence: f.health.sentence, disabled: !!f.disabled, errors: f.errors || 0, errorText: f.errorText || "", checkedAt: f.checkedAt, feedUrl: f.feedUrl, siteUrl: f.siteUrl }));
  }
  async _categoryId(title, create) {
    const all = (await this.mf.categories()) || []; const c = all.find(x => x.title === title); if (c) return c.id;
    if (!create) return null; const n = await this.mf.createCategory(title); return n.id;
  }
  async _rereadFeeds() { const col = collector(); this._applyFeeds(await this.mf.feeds(), col); col.done(this.server, this.now()); }
  async feedUpdate(id, patch = {}) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    const f = this.cache.feeds.find(x => x.id === Number(id)); if (!f) return { ok: false, sentence: "That feed is no longer in the list. Refresh and try again." };
    const body = {}; let cat = null; let title = f.title;
    if (patch.title !== undefined) { const t = String(patch.title).replace(/\s+/g, " ").trim().slice(0, 200); if (!t) return { ok: false, sentence: "A feed needs a name." }; if (t !== f.title) { body.title = t; title = t; } }
    if (patch.category !== undefined) { const c = splitCategory(patch.category).join("/").slice(0, 120); if (!c) return { ok: false, sentence: "A feed needs a folder." }; if (c !== f.category) cat = c; }
    if (patch.disabled !== undefined && !!patch.disabled !== !!f.disabled) body.disabled = !!patch.disabled;
    if (!Object.keys(body).length && !cat) return { ok: true, unchanged: true, sentence: "Nothing to change." };
    this._act("manage", "Updating the feed");
    try {
      if (cat) body.category_id = await this._categoryId(cat, true);
      await this.mf.updateFeed(f.id, body); this._netOk("miniflux"); await this._rereadFeeds();
      for (const it of Object.values(this.cache.items)) if (it.feedId === f.id) { it.feedTitle = title; if (cat) it.category = cat; }
      this._reindex(); await this.persist(["cache", "net", "server", "searchIndex"]); this._notify();
      const say = body.disabled === true ? `Disabled “${title}”. Miniflux will stop fetching it until you enable it again.` : body.disabled === false ? `Enabled “${title}”.` : cat && body.title ? `Renamed to “${title}” and moved to ${cat}.` : cat ? `Moved “${title}” to ${cat}.` : `Renamed to “${title}”.`;
      return { ok: true, sentence: say };
    } catch (e) { this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "The change failed for an unexpected reason. Nothing was changed here." }; }
    finally { this._actEnd("manage"); }
  }
  async feedDelete(id, confirm) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    const f = this.cache.feeds.find(x => x.id === Number(id)); if (!f) return { ok: false, sentence: "That feed is no longer in the list. Refresh and try again." };
    if (String(confirm == null ? "" : confirm).trim() !== f.title.trim()) return { ok: false, sentence: "The name typed did not match the feed, so nothing was deleted." };
    this._act("manage", "Deleting the feed");
    try {
      await this.mf.deleteFeed(f.id); this._netOk("miniflux");
      const gone = new Set(); for (const it of Object.values(this.cache.items)) if (it.feedId === f.id) { gone.add(it.id); delete this.cache.items[it.id]; delete this.bodies[it.id]; delete this.searchIndex[it.id]; }
      for (const op of this.pendingOps) if (op.op === "status") op.ids = op.ids.filter(i => !gone.has(i));
      this.pendingOps = this.pendingOps.filter(op => op.op !== "status" || op.ids.length);
      this.cache.feeds = this.cache.feeds.filter(x => x.id !== f.id); this._idxDirty = true; this._vecs.clear();
      await this.persist(["cache", "net", "pendingOps", "searchIndex"]); await this.storage.set({ bodies: this.bodies }); this._notify();
      return { ok: true, sentence: `Deleted “${f.title}” and its ${gone.size} article${gone.size === 1 ? "" : "s"} kept on this machine.` };
    } catch (e) { this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "The delete failed for an unexpected reason. Nothing was deleted." }; }
    finally { this._actEnd("manage"); }
  }
  // Renames a folder, and every folder inside it, one call at a time. Folders are Miniflux categories whose titles are paths such as "Defence/Shipbuilding".
  async folderRename(path, to) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    const cur = splitCategory(path).join("/"); const leaf = String(to == null ? "" : to).replace(/\//g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!cur) return { ok: false, sentence: "That folder cannot be renamed." }; if (!leaf) return { ok: false, sentence: "A folder needs a name." };
    const parts = splitCategory(cur); const next = [...parts.slice(0, -1), leaf].join("/"); if (next === cur) return { ok: true, unchanged: true, sentence: "Nothing to change." };
    this._act("manage", "Renaming the folder"); const renamed = [];
    try {
      const all = (await this.mf.categories()) || []; const mine = all.filter(c => c.title === cur || c.title.startsWith(cur + "/"));
      if (!mine.length) return { ok: false, sentence: "That folder was not found in Miniflux. Refresh and try again." };
      const plan = mine.map(c => ({ id: c.id, from: c.title, to: next + c.title.slice(cur.length) })); const taken = new Set(all.map(c => c.title));
      for (const p of plan) if (taken.has(p.to) && !plan.some(q => q.from === p.to)) return { ok: false, sentence: `A folder called “${p.to}” already exists, so nothing was renamed.` };
      const topBefore = this.tree().filter(x => !x.parent).map(x => x.id);
      for (const p of plan) { await this.mf.updateCategory(p.id, { title: p.to }); renamed.push(p); }
      this._netOk("miniflux"); await this._rereadFeeds();
      for (const it of Object.values(this.cache.items)) { const c = it.category; if (c === cur || (c && c.startsWith(cur + "/"))) it.category = next + c.slice(cur.length); }
      const fromId = "cat:" + cur, toId = "cat:" + next;
      if (parts.length === 1) await this.setOrder(topBefore.map(x => (x === fromId ? toId : x)));
      await this.persist(["cache", "net", "server"]); this._notify();
      return { ok: true, sentence: `Renamed “${cur}” to “${next}”${plan.length > 1 ? ` and the ${plan.length - 1} folder${plan.length > 2 ? "s" : ""} inside it` : ""}.`, map: { from: fromId, to: toId } };
    } catch (e) {
      this._netErr("miniflux", e); try { await this._rereadFeeds(); await this.persist(["cache", "net", "server"]); this._notify(); } catch { /* the first error is the one to report */ }
      const part = renamed.length ? ` ${renamed.length} folder${renamed.length === 1 ? " was" : "s were"} already renamed (${renamed.map(r => `“${r.to}”`).join(", ")}); the rest were left as they were.` : " Nothing was renamed.";
      return { ok: false, sentence: (e instanceof PlainError ? e.plain : "The rename failed for an unexpected reason.") + part };
    } finally { this._actEnd("manage"); }
  }
  _later(ms) {
    const t = setTimeout(async () => { this._timers.delete(t); try { await this.refresh({ feeds: true }); this._notify(); } catch { /* shown on the Sync page */ } }, ms);
    if (t && t.unref) t.unref(); this._timers.add(t);
  }
  // Ask Miniflux to fetch now, then bring in what arrived. A feed is fetched while Pravaha waits; a folder is fetched by Miniflux in the background, so Pravaha looks again a little later.
  async refreshScope(scope) {
    if (!this.mf) return { ok: false, sentence: "Miniflux is not set up yet." };
    this._act("pull", "Asking Miniflux to refresh");
    try {
      const before = Object.keys(this.cache.items).length; const s = String(scope || "all");
      if (s.startsWith("feed:")) {
        const f = this.cache.feeds.find(x => x.id === Number(s.slice(5))); if (!f) return { ok: false, sentence: "That feed is no longer in the list." };
        await this.mf.refreshFeed(f.id); setCap(this.server, "feedRefresh", true); await this.refresh({ feeds: true }); this._notify();
        const n = Object.keys(this.cache.items).length - before; return { ok: true, sentence: n > 0 ? `Fetched “${f.title}”: ${n} new article${n === 1 ? "" : "s"}.` : `Fetched “${f.title}”: nothing new.` };
      }
      if (s.startsWith("cat:")) {
        const path = splitCategory(s.slice(4)).join("/"); const all = (await this.mf.categories()) || []; const mine = all.filter(c => c.title === path || c.title.startsWith(path + "/"));
        if (!mine.length) return { ok: false, sentence: "That folder was not found in Miniflux." };
        for (const c of mine) await this.mf.refreshCategory(c.id);
        setCap(this.server, "categoryRefresh", true); const n = this.cache.feeds.filter(f => f.category === path || f.category.startsWith(path + "/")).length;
        this._later(6000); this._later(20000); await this.persist(["server"]);
        return { ok: true, sentence: `Asked Miniflux to refresh ${n} feed${n === 1 ? "" : "s"} in “${path}”. New articles appear here within a minute.` };
      }
      await this.mf.refreshAll(); this._later(6000); this._later(20000);
      return { ok: true, sentence: "Asked Miniflux to refresh every feed. New articles appear here within a minute." };
    } catch (e) {
      if (notFound(e) && String(scope).startsWith("cat:")) setCap(this.server, "categoryRefresh", false);
      this._netErr("miniflux", e); return { ok: false, sentence: e instanceof PlainError ? e.plain : "The refresh failed for an unexpected reason." };
    } finally { this._actEnd("pull"); }
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
        catch (e) { if (e && e.code !== "unreachable" && e.code !== "timeout" && e.code !== "auth") this.icons[f.id] = ""; } // a refused icon is not asked for again every poll
      }));
    }
    await this.storage.set({ icons: this.icons });
  }

  async open(id) {
    const it = this.cache.items[id]; if (!it) return null;
    this._evt(it, "open"); this.sessionFeeds.add(it.feedId);
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this._sendLater();
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
    await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this.flushOps(); this._notify();
    return { saved: it.starred, tags };
  }
  async dismiss(id) {
    const it = this.cache.items[id]; if (!it) return;
    this._evt(it, "dismiss");
    if (it.status !== "read") { it.status = "read"; this._queue({ op: "status", ids: [id], status: "read" }); }
    await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this._sendLater();
  }
  async undismissAll() {
    const d = this._derive();
    for (const id of d.dismissed) { const it = this.cache.items[id]; this.log.append("undismiss", { entry: id, feed: it && it.feedId }); }
    this._derived = null; this._model = null;
    // Dismissing marked the articles read in Miniflux, so undoing has to bring them back as unread.
    const back = [...d.dismissed].filter(id => this.cache.items[id] && this.cache.items[id].status === "read");
    for (const id of back) this.cache.items[id].status = "unread";
    if (back.length) this._queue({ op: "status", ids: back, status: "unread" });
    await this.persist(["cache", "events", "pendingOps"]); this._notify(); await this._sendLater();
  }
  async train(type, key, value) { return this.trainMany([{ type, key, value }]); }
  // Several rules at once, written as separate events so that older copies of Pravaha still understand every one of them.
  // Training changes the score only, so the model stays; a thumbs up also nudges the interest profile, which does rebuild it.
  async trainMany(list) {
    let pull = false;
    for (const r of list || []) {
      if (!r || typeof r.type !== "string" || !Number.isFinite(r.value) || Math.abs(r.value) > 3 || r.key === undefined || r.key === null || r.key === "") continue;
      const payload = { type: r.type, key: r.type === "story" ? String(r.key) : String(r.key).toLowerCase(), value: r.value };
      if (r.type === "story") { pull = true; if (Array.isArray(r.keys)) payload.keys = r.keys; if (Array.isArray(r.terms)) payload.terms = r.terms; }
      this.log.append("train", { payload });
    }
    this._derived = null; if (pull) this._model = null;
    await this.persist(["events"]); this._notify();
  }
  trainingRules() { return this._derive().training; }

  // ---------- training an article ----------
  // Everything the reader needs to train one article: its tags (yours from Raindrop first), the words that carry it, and the Raindrop context.
  trainerFor(id) {
    const it = this.cache.items[id]; if (!it) return null;
    const d = this._derive(), m = this._buildModel(), v = this._itemVec(it);
    const val = (type, key) => { const r = d.training.find(x => x.type === type && x.key === String(key).toLowerCase()); return r ? r.value : 0; };
    const own = this._savedCopy(it, m); const tags = []; const seen = new Set();
    const addTag = (tag, source) => { const k = String(tag).toLowerCase(); if (!k || seen.has(k) || tags.length >= 6) return; seen.add(k); tags.push({ tag: String(tag), key: k, source, value: val("tag", k) }); };
    for (const t of (own && own.tags) || []) addTag(t, "raindrop");
    for (const t of suggestTags(v.vec, v.stems, m.profiles, 5)) addTag(t.tag, "suggested");
    for (const t of it.tags || []) addTag(t, "feed");
    const words = []; const have = new Set(v.stems); const wseen = new Set();
    for (const raw of String(it.title || "").split(/[^\p{L}\p{N}]+/u)) {
      const st = raw.length > 3 ? tokenize(raw)[0] : undefined;
      if (!st || !have.has(st) || wseen.has(st) || words.length >= 5) continue; wseen.add(st); words.push({ word: raw.toLowerCase(), key: st, value: val("keyword", st) });
    }
    const rel = [];
    if (m.bms.length) for (let i = 0; i < m.bms.length; i++) { const b = m.bms[i]; if (b === own) continue; const c = cosine(v.vec, m.bmVecs[i]); if (c >= 0.22) rel.push({ c, b }); }
    rel.sort((a, b) => b.c - a.c);
    const pick = (b) => ({ title: b.title, tags: b.tags || [], note: String(b.note || "").slice(0, 240), link: b.link || "", domain: b.domain || "", at: b.at || 0 });
    return { id, story: (d.story[String(id)] || {}).value || 0, tags, words,
      feed: { key: String(it.feedId), title: it.feedTitle, value: val("feed", it.feedId) }, author: it.author ? { key: String(it.author).toLowerCase(), name: it.author, value: val("author", it.author) } : null,
      raindrop: { configured: !!this.rd, count: m.bms.length, exact: own ? pick(own) : null, related: rel.slice(0, 2).map(x => ({ ...pick(x.b), sim: Math.round(x.c * 100) / 100 })) } };
  }
  // A thumb is a gentler nudge than clicking one tag yourself: each of its rules carries 0.3 of a full click, so six rules together stay under the scorer's cap
  // of 0.2 and a tag clicked afterwards still moves the score.
  // The thumb: up, down, or 0 to take it back. It sets a rule on the article's top three tags and top three words, and remembers which, so a second press undoes exactly that.
  scoreRow(id) { const it = this.cache.items[id]; if (!it) return null; const s = this.scoreOne(it); return { score: s.score, why: whyRanked(s.breakdown), breakdown: roundBreakdown(s.breakdown) }; }
  async rateStory(id, value) {
    const it = this.cache.items[id]; if (!it || ![1, -1, 0].includes(value)) return { ok: false };
    const d = this._derive(); const prev = d.story[String(id)]; const list = []; let keys = [];
    if (value === 0 && !prev) return { ok: true, value: 0, labels: [], ...this.scoreRow(id) }; // nothing to take back: writing a 0 would only hide another machine's thumb that has not arrived yet
    const cur = (k) => { const r = d.training.find(x => x.type === k.type && x.key === k.key); return r ? r.value : 0; }; const w = value * STORY_WEIGHT;
    if (value !== 0) {
      const t = this.trainerFor(id);
      keys = [...t.tags.filter(x => x.source !== "feed").slice(0, 3).map(x => ({ type: "tag", key: x.key })), ...t.words.slice(0, 3).map(x => ({ type: "keyword", key: x.key }))];
      if (!keys.length) keys = t.tags.slice(0, 3).map(x => ({ type: "tag", key: x.key }));
    }
    if (prev) for (const k of prev.keys) if (cur(k) === prev.value * STORY_WEIGHT && !keys.some(x => x.type === k.type && x.key === k.key)) list.push({ type: k.type, key: k.key, value: 0 });
    for (const k of keys) list.push({ ...k, value: w });
    list.push(value === 0 ? { type: "story", key: String(id), value: 0 } : { type: "story", key: String(id), value, keys, terms: value > 0 ? this._itemVec(it).stems : undefined });
    await this.trainMany(list);
    const t2 = value ? this.trainerFor(id) : null;
    const labels = keys.map(k => k.type === "tag" ? "#" + k.key : ((t2 && t2.words.find(w => w.key === k.key)) || {}).word || k.key);
    return { ok: true, value, labels, ...this.scoreRow(id) };
  }

  // ---------- stats and digest ----------
  stats() {
    const now = this.now(), d = this._derive(), events = this.log.list().filter(e => now - Number(e.ts.split(".")[0]) < 30 * DAY);
    const cat = {}; const meta = this._feedMeta();
    let opens = 0, cards = 0, saves = 0, dismisses = 0, dwellMs = 0;
    for (const e of events) {
      if (e.type === "open") opens++; else if (e.type === "card") cards++; else if (e.type === "dismiss") dismisses++; else if (e.type === "dwell") dwellMs += (e.payload && e.payload.ms) || 0;
      else if (e.type === "save") { saves++; const c = splitCategory((meta[e.feed] && meta[e.feed].category) || "Other")[0]; cat[c] = (cat[c] || 0) + 1; }
    }
    const bands = [[0, .3], [.3, .45], [.45, .6], [.6, 1.01]].map(([lo, hi]) => ({ lo, hi: Math.min(hi, 1), n: 0, opened: 0, saved: 0 }));
    const ctx = this._scoreCtx();
    for (const it of Object.values(this.cache.items)) { const s = this.scoreOne(it, ctx).score; const b = bands.find(x => s >= x.lo && s < x.hi) || bands[3]; b.n++; if (d.opens.has(it.id)) b.opened++; if (it.starred) b.saved++; }
    const league = this.cache.feeds.map(f => ({ id: f.id, title: f.title, authority: standingOf(d.standing, f.id), health: f.health.state }))
      .sort((a, b) => b.authority - a.authority).slice(0, 12);
    return { opens, cards, saves, dismisses, dwellMinutes: Math.round(dwellMs / 60000), savesByFolder: Object.entries(cat).sort((a, b) => b[1] - a[1]), bands, league, pendingHistory: this.pendingHistory };
  }
  async writeDigest() {
    if (!this.dav) throw new PlainError("The digest needs the WebDAV storage to be set up first.", "not-configured");
    const now = this.now(), d = this._derive(); const sc = this._unreadScored();
    const week = isoWeek(now);
    const top = sc.filter(x => now - x.it.publishedAt < 7 * DAY).sort((a, b) => b.s.score - a.s.score).slice(0, 15).map(x => { const rd = (this.trainerFor(x.it.id) || {}).raindrop || {}; const because = rd.exact ? "saved in Raindrop" : rd.related && rd.related[0] ? `close to your Raindrop save “${rd.related[0].title}”` : ""; return { ...x.it, score: x.s.score, because }; });
    const saved = Object.values(this.cache.items).filter(i => i.starred && now - i.publishedAt < 14 * DAY).map(i => ({ ...i, tags: this.suggestTagsFor(i.id).map(t => t.tag) }));
    const meta = this._feedMeta();
    const authority = Object.keys(d.standing).filter(id => id !== "_mean").map(id => ({ title: (meta[id] && meta[id].title) || id, value: standingOf(d.standing, id) })).sort((a, b) => b.value - a.value);
    const terms = topTerms(this._buildModel().centroid, 15);
    const label = (r) => r.type === "tag" ? "#" + r.key.replace(/\s+/g, "-") : r.type === "feed" ? ((meta[r.key] && meta[r.key].title) || "a feed") : r.key;
    const trained = { more: d.training.filter(r => r.value > 0).map(label).slice(0, 12), less: d.training.filter(r => r.value < 0).map(label).slice(0, 12) };
    const md = buildDigest({ now, week, top, saved, authority, centroidTerms: terms, previousTerms: this.cache.lastDigestTerms, trained });
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
