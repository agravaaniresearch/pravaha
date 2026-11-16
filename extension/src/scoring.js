// Relevance scoring. Every function is pure: no clock, no randomness, and the set-valued ones (feedStanding, hotness)
// do not depend on input order, so two machines with the same events get the same standing.
// 0.8.0 rework after a mathematical review (docs/RELEVANCE_REVIEW.md): engagement-rate standing, best-tag match, bounded profile, hot stories.
export const DEFAULT_WEIGHTS = { tag: 0.40, echo: 0.20, authority: 0.20, freshness: 0.10, hot: 0.10 };
export const AUTHORITY_BASE = 0.3;      // legacy path only (authorityOf); the posterior standing is neutral at 0.5
export const HALF_LIFE_DAYS = 14;
export const NOVELTY_BOOST = 1.08;
export const AUTHORITY_SIGNALS = { open: 0.15, dwell: 0.10, readNoOpen: -0.05, save: 0.25, card: 0.05 }; // kept for eventlog.js
// How much one article "paid off", 0..1, counted once per article however many machines or repeats logged it.
export const ENGAGEMENT = { card: 0.25, open: 0.5, dwell: 0.25, save: 1, dismiss: 1, readNoOpen: 0.5 };
const DAY = 86400000, HOUR = 3600000, FUTURE_SLACK = 2 * HOUR;

const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, num(x, lo)));   // NaN maps to lo instead of leaking out
const halve = (ageMs, halfLifeMs) => Math.pow(0.5, Math.max(0, num(ageMs)) / halfLifeMs);

// ---------- freshness ----------
export function freshness(hours) { const h = Math.max(0, num(hours)); return 1 / (1 + Math.pow(h / 24, 1.129)); }
// Age from the entry's published time, guarded: a publish date later than when Miniflux first stored the entry (seenAt,
// Miniflux created_at) is not trusted; a missing date counts as one day old instead of 1970; the future clamps to now.
export function ageHours(item, now) {
  const seen = num(item && item.seenAt) > 0 ? item.seenAt : null;
  let t = num(item && item.publishedAt) > 0 ? item.publishedAt : seen;
  if (t === null || !Number.isFinite(now)) return 24;
  if (seen !== null && t > seen + FUTURE_SLACK) t = seen;
  return Math.max(0, (now - t) / HOUR);
}

// ---------- similarity ----------
export const squash = (cos, k = 3) => 1 - Math.exp(-k * Math.max(0, num(cos))); // 0.2 -> 0.45, 0.5 -> 0.78
// Dot product of two unit sparse vectors (= cosine). Walks the first argument, so pass the short article vector first:
// no Object.keys of a 500-term profile per call. Summation order is fixed by the first argument's key order.
export function dot(a, b) {
  if (!a || !b) return 0; let s = 0;
  for (const k in a) { const v = b[k]; if (v) s += a[k] * v; }
  return num(s);
}
function topKeys(v, n) { return Object.keys(v).sort((a, b) => v[b] - v[a] || (a < b ? -1 : 1)).slice(0, n); }
function unit(o) { let s = 0; for (const k in o) s += o[k] * o[k]; s = Math.sqrt(s); const r = {}; if (s > 0) for (const k in o) r[k] = o[k] / s; return r; }
function pruneTop(v, keep) { const r = {}; for (const k of topKeys(v, keep)) r[k] = Math.round(v[k] * 1e5) / 1e5; return unit(r); }

// Best match against your own Raindrop tags. A single mean of 4,400 bookmarks sits between your interests, so an article on a
// minority interest scores close to an off-topic one; the best single tag does not have that problem. Small tags are shrunk
// by n/(n+1) and tags with fewer than minCount saves are ignored. The postings index is built once per profiles object.
const TAG_INDEX = new WeakMap();
export function bestTag(vec, profiles, minCount = 2) {
  if (!vec || !profiles) return { tag: null, cos: 0 };
  let ix = TAG_INDEX.get(profiles);
  if (!ix) {
    const names = Object.keys(profiles).filter(t => num(profiles[t].count) >= minCount && profiles[t].vec).sort(); const post = new Map();
    names.forEach((t, i) => { for (const k in profiles[t].vec) { const w = profiles[t].vec[k]; if (!w) continue; let l = post.get(k); if (!l) post.set(k, l = []); l.push(i, w); } });
    ix = { names, post, shrink: names.map(t => profiles[t].count / (profiles[t].count + 1)), acc: new Float64Array(names.length) };
    TAG_INDEX.set(profiles, ix);
  }
  const acc = ix.acc, hit = [];
  for (const k in vec) { const w = vec[k], l = w && ix.post.get(k); if (l) for (let j = 0; j < l.length; j += 2) { if (acc[l[j]] === 0) hit.push(l[j]); acc[l[j]] += w * l[j + 1]; } }
  let best = -1, bc = 0;
  for (const i of hit) { const c = acc[i] * ix.shrink[i]; if (c > bc || (c === bc && best >= 0 && i < best)) { bc = c; best = i; } acc[i] = 0; }
  return { tag: best >= 0 ? ix.names[best] : null, cos: num(bc) };
}

// The interest profile as a weighted mixture instead of a chain of blends. Pulls (opens, saves, thumbs) decay in time and
// together can never take more than `share` of the profile, so 4,400 bookmarks are not erased by the last hundred opens.
// pulls: [{kind, at, vec}] where vec is the unit vector of the pull's terms. The result has at most `keep` terms.
export const PULL_WEIGHT = { save: 1, up: 0.67, open: 0.42, card: 0.17 };
export function mixProfile(base, pulls, now, { share = 0.3, halfLifeDays = 60, keep = 500, evidence = 5 } = {}) {
  const acc = {}; let W = 0;
  for (const p of pulls || []) {
    if (!p || !p.vec) continue; const w = num(PULL_WEIGHT[p.kind]) * halve(num(now) - num(p.at, now), halfLifeDays * DAY); if (!(w > 0)) continue;
    W += w; for (const k in p.vec) acc[k] = (acc[k] || 0) + w * num(p.vec[k]);
  }
  const lam = W > 0 ? share * W / (W + evidence) : 0; const o = {};
  for (const k in base || {}) o[k] = (1 - lam) * num(base[k]);
  if (W > 0) for (const k in acc) o[k] = (o[k] || 0) + lam * acc[k] / W;
  return pruneTop(o, keep);
}

// ---------- feed standing: decayed Beta-Bernoulli engagement rate ----------
// rate = (prior * m + engaged) / (prior + trials), standing = rate / (rate + m), where m is your average rate over all feeds.
// An average feed sits at 0.5, a feed three times better than your average at 0.75. Volume cannot buy standing: a firehose
// with 100 articles a day and 2 opens has a low rate. Trials come from "calibration" events of kind "exposure" (one per day per
// machine: {kind:"exposure", day:"YYYY-MM-DD", feeds:{id:count}}, merged by max per feed and day, so a set union of events
// gives the same answer), and are never fewer than the articles you touched. A save that was unsaved, or a dismiss that was
// undone, counts as its final state, so an undo is exact. Each article decays from when you first touched it.
// Order-free: same set of events in any order, same result.
export function feedStanding(events, now, { halfLifeDays = HALF_LIFE_DAYS, prior = 10, baseRate = 0.05, baseTrials = 50 } = {}) {
  const H = halfLifeDays * DAY, ent = new Map(), expo = new Map();
  for (const e of events || []) {
    if (!e || typeof e.ts !== "string") continue; const wall = Number(e.ts.slice(0, 14)); if (!Number.isFinite(wall)) continue; const p = e.payload || {};
    if (e.type === "calibration") {
      if (p.kind === "exposure" && /^\d{4}-\d\d-\d\d$/.test(String(p.day)) && p.feeds && typeof p.feeds === "object")
        for (const f of Object.keys(p.feeds)) { const c = Math.min(5000, num(Number(p.feeds[f]))); const k = `${f}|${p.day}`; if (c > 0 && c > (expo.get(k) || 0)) expo.set(k, c); }
      continue;
    }
    if (e.entry === undefined || e.entry === null || e.feed === undefined || e.feed === null) continue;
    const id = String(e.entry), feed = String(e.feed); let s = ent.get(id);
    if (!s) ent.set(id, s = { feed, at: wall, card: 0, open: 0, dwell: 0, rno: 0, save: "", unsave: "", dis: "", undis: "" });
    if (feed < s.feed) s.feed = feed; if (wall < s.at) s.at = wall; // first touch: an undo or a late save does not refresh it
    const last = (f) => { if (e.ts > s[f]) s[f] = e.ts; };
    switch (e.type) {
      case "card": s.card = 1; break; case "open": s.open = 1; break; case "read_no_open": s.rno = 1; break;
      case "dwell": if (num(p.ms) > 15000) s.dwell = 1; break;
      case "save": last("save"); break; case "unsave": last("unsave"); break; case "dismiss": last("dis"); break; case "undismiss": last("undis"); break;
    }
  }
  const S = new Map(), T = new Map(), N = new Map(), X = new Map(), add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const id of [...ent.keys()].sort()) {
    const s = ent.get(id), d = halve(now - s.at, H), saved = s.save > s.unsave, dis = s.dis > s.undis;
    const u = Math.min(1, ENGAGEMENT.card * s.card + ENGAGEMENT.open * s.open + ENGAGEMENT.dwell * s.dwell + (saved ? ENGAGEMENT.save : 0));
    add(S, s.feed, d * u); add(T, s.feed, d); add(N, s.feed, d * ((dis ? ENGAGEMENT.dismiss : 0) + (s.rno && !s.open ? ENGAGEMENT.readNoOpen : 0)));
  }
  for (const k of [...expo.keys()].sort()) { const i = k.indexOf("|"); add(X, k.slice(0, i), halve(now - Date.parse(k.slice(i + 1) + "T12:00:00Z"), H) * expo.get(k)); }
  const feeds = [...new Set([...S.keys(), ...X.keys(), ...N.keys()])].sort(); const trials = {}; let sumS = 0, sumT = 0;
  for (const f of feeds) { trials[f] = Math.max(X.get(f) || 0, T.get(f) || 0) + (N.get(f) || 0); sumS += S.get(f) || 0; sumT += trials[f]; }
  const m = (sumS + baseRate * baseTrials) / (sumT + baseTrials), out = { _mean: m };
  for (const f of feeds) {
    const rate = (prior * m + (S.get(f) || 0)) / (prior + trials[f]);
    out[f] = { value: rate / (rate + m), rate, engaged: S.get(f) || 0, trials: trials[f] };
  }
  return out;
}
export function standingOf(standing, feedId) { const s = standing && standing[String(feedId)]; return s ? clamp(s.value) : 0.5; }
// The payload a machine logs once a day (type "calibration"): how many articles each feed published that UTC day, as Miniflux has them.
export function exposurePayload(items, dayStartMs) {
  if (!Number.isFinite(dayStartMs)) return null; const feeds = {}, end = dayStartMs + DAY;
  for (const it of items || []) { const t = num(it.publishedAt); if (t >= dayStartMs && t < end && it.feedId != null) feeds[it.feedId] = (feeds[it.feedId] || 0) + 1; }
  return { kind: "exposure", day: new Date(dayStartMs).toISOString().slice(0, 10), feeds };
}

// ---------- hot: the same story covered by several feeds (Fever) ----------
// Candidate pairs share at least minShared of their top terms (item.stems, the engine's top 12, when present); terms in more
// than maxDf items are not specific enough to propose a pair.
// A pair counts when the two items come from different feeds, are published within windowHours of each other and their
// vectors have cosine >= minCos. No transitive chaining: an item's heat is the number of OTHER feeds among its own neighbours.
export function hotness(items, { windowHours = 36, minCos = 0.35, topK = 8, maxDf = 0, minShared = 2 } = {}) {
  const list = (items || []).filter(it => it && it.vec && Number.isFinite(it.publishedAt))
    .sort((a, b) => a.publishedAt - b.publishedAt || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const n = list.length, cap = maxDf || Math.max(8, Math.ceil(n * 0.02)), post = new Map(), win = windowHours * HOUR;
  list.forEach((it, i) => { const top = Array.isArray(it.stems) && it.stems.length ? it.stems.slice(0, topK) : topKeys(it.vec, topK); for (const t of new Set(top)) { let l = post.get(t); if (!l) post.set(t, l = []); l.push(i); } });
  const shared = new Map(), nb = list.map(() => []);
  for (const l of post.values()) {
    if (l.length < 2 || l.length > cap) continue;
    for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
      const i = l[a], j = l[b]; if (list[j].publishedAt - list[i].publishedAt > win) break;
      if (String(list[i].feedId) !== String(list[j].feedId)) { const key = i * n + j; shared.set(key, (shared.get(key) || 0) + 1); }
    }
  }
  for (const [key, c] of shared) { if (c < minShared) continue; const i = Math.floor(key / n), j = key % n; if (dot(list[i].vec, list[j].vec) >= minCos) { nb[i].push(j); nb[j].push(i); } }
  const out = new Map();
  list.forEach((it, i) => { const fs = new Set(nb[i].map(j => String(list[j].feedId))); out.set(it.id, { others: fs.size, ids: nb[i].map(j => list[j].id).sort((a, b) => (String(a) < String(b) ? -1 : 1)) }); });
  return out;
}
export const hotSignal = (others) => clamp(Math.log(1 + Math.max(0, num(others))) / Math.log(6)); // 1 other feed 0.39, 2: 0.61, 5+: 1

// ---------- legacy standing, training, the score ----------
export function decay(ageMs) { return halve(ageMs, HALF_LIFE_DAYS * DAY); }
export function authorityOf(delta) { return clamp(AUTHORITY_BASE + num(delta)); }
export function domainBonus(visits) { return Math.min(0.15, 0.05 * Math.log2(1 + Math.max(0, num(visits)) / 3)); } // 3 visits 0.05, 9: 0.10, 21+: 0.15

export function trainingAdjust(item, rules) {
  let sum = 0;
  for (const r of rules || []) {
    if (!r || !Number.isFinite(r.value)) continue; const v = Math.max(-3, Math.min(3, r.value));
    if (r.type === "feed" && r.key === String(item.feedId)) sum += v;
    else if (r.type === "author" && item.author && r.key === String(item.author).toLowerCase()) sum += v;
    else if (r.type === "keyword" && item.stems && item.stems.includes(r.key)) sum += v;
    else if (r.type === "tag" && item.tags && item.tags.includes(r.key)) sum += v;
  }
  return clamp(sum * 0.08, -0.2, 0.2);
}

// ctx as before, plus optional: profiles (Raindrop tag profiles), standing (from feedStanding), hot (from hotness), k (squash).
// Without the new fields the function behaves as the old one except for the guards and the smooth domain bonus.
// A signal with no source at all (no echo snapshot and no history visits; no hot map) gives its weight to the others instead
// of silently capping every score: without history the old maximum was 0.7 before novelty.
const NONEMPTY = new WeakMap(); // vectors are never mutated after they are built, so the answer can be kept per object
const nonEmpty = (o) => { if (!o || typeof o !== "object") return false; let r = NONEMPTY.get(o); if (r === undefined) { r = Object.keys(o).length > 0; NONEMPTY.set(o, r); } return r; };
export function scoreItem(item, ctx) {
  const cos = ctx.cosine || dot, vec = item.vec || {}, k = num(ctx.k, 3);
  const w = normaliseWeights(ctx.weights || DEFAULT_WEIGHTS, { echo: nonEmpty(ctx.echo) || nonEmpty(ctx.domainVisits), hot: !!ctx.hot });
  const centroidCos = ctx.centroid ? num(cos(vec, ctx.centroid)) : 0;
  const best = ctx.profiles ? bestTag(vec, ctx.profiles) : { tag: null, cos: 0 };
  const tag = squash(Math.max(centroidCos, best.cos), k);
  const visits = num(ctx.domainVisits && ctx.domainVisits[item.domain]);
  const echo = squash((ctx.echo ? num(cos(vec, ctx.echo)) : 0) + domainBonus(visits), k);
  const authority = ctx.standing ? standingOf(ctx.standing, item.feedId) : authorityOf(ctx.authorityDelta && ctx.authorityDelta[item.feedId]);
  const fresh = freshness(ageHours(item, ctx.now));
  const h = ctx.hot && ctx.hot.get(item.id), hotOthers = h ? h.others : 0, hot = hotSignal(hotOthers);
  const training = trainingAdjust(item, ctx.training);
  const raw = w.tag * tag + w.echo * echo + w.authority * authority + w.freshness * fresh + w.hot * hot + training;
  const novelty = ctx.novelty !== false && ctx.sessionFeeds && !ctx.sessionFeeds.has(item.feedId) ? NOVELTY_BOOST : 1;
  let final = clamp(raw * novelty);
  const enr = ctx.enrichment && ctx.enrichment[item.id];
  if (enr && Number.isFinite(enr.score)) final = clamp(0.8 * final + 0.2 * clamp(enr.score));
  return {
    score: Math.round(final * 1000) / 1000,
    breakdown: { tagOverlap: tag, bookmarkEcho: echo, feedAuthority: authority, freshness: fresh, hot, training, noveltyBoost: novelty, bestTag: best.tag, hotOthers },
    flag: enr && enr.flag ? enr.flag : null
  };
}

// Missing, negative or non-numeric weights fall back to the default for that signal, so a stored four-weight object from 0.7.0
// still works (hot gets its default and everything is renormalised). Always sums to 1.
// `present` (optional) switches off signals that have no source; their weight is shared out among the rest.
export function normaliseWeights(w, present = {}) {
  const o = {}; let t = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) { const v = present[k] === false ? 0 : w && Number.isFinite(w[k]) && w[k] >= 0 ? w[k] : DEFAULT_WEIGHTS[k]; o[k] = v; t += v; }
  for (const k in o) o[k] = t > 0 ? o[k] / t : present[k] === false ? 0 : DEFAULT_WEIGHTS[k];
  return o;
}

export function whyRanked(b) {
  const parts = [];
  if (b.tagOverlap > 0.6) parts.push(b.bestTag ? `close to your #${b.bestTag} saves` : "close to your saved tags");
  if (b.bookmarkEcho > 0.6) parts.push("matches sites you read");
  if (b.hotOthers > 0) parts.push(`also covered by ${b.hotOthers} other feed${b.hotOthers > 1 ? "s" : ""}`);
  if (b.feedAuthority > 0.65) parts.push("a feed you act on");
  if (b.feedAuthority < 0.25) parts.push("a feed you tend to skip"); // below the legacy base 0.3 and the posterior neutral 0.5
  if (b.freshness > 0.7) parts.push("fresh");
  if (b.training > 0.02) parts.push("boosted by your training");
  if (b.training < -0.02) parts.push("lowered by your training");
  if (b.noveltyBoost > 1) parts.push("a feed you have not opened this session");
  return parts.length ? parts.join(", ") : "an average match";
}

// Display mapping for grade.js: an odds stretch instead of score/0.65 clipped at 1. Strictly increasing, never clips, keeps
// the top of the list distinguishable. odds 1.5: 0.2 -> 0.27, 0.4 -> 0.50, 0.6 -> 0.69, 0.8 -> 0.86. Tune odds from the
// stats page once real scores are seen; odds 1 is the identity. This is a presentation choice, not a fix.
export function displayOf(score, odds = 1.5) { const s = clamp(score); return s >= 1 ? 1 : (odds * s) / (odds * s + 1 - s); }

// Text clean-up to run before tokenize (text.js): decode entities so "&rsquo;" is not a word, keep designators such as F-35,
// S-400 and MQ-9B as one token instead of losing them to the length and digit filters, and keep "US" (the country).
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: " ", ndash: " ", hellip: " " };
export function prepText(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, c) => c[0] === "#" ? (() => { const n = c[1] === "x" || c[1] === "X" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " "; })() : (ENT[c.toLowerCase()] ?? " "))
    .replace(/\b([A-Za-z]{1,3})-(\d{1,4}[A-Za-z]{0,2})\b/g, "$1$2").replace(/\bU\.?S\.?(?=[\s,;:)]|$)/g, "USA");
}
