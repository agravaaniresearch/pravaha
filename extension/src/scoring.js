// The four scorers from the spec, plus training and novelty. Every function is pure.
export const DEFAULT_WEIGHTS = { tag: 0.40, echo: 0.30, authority: 0.20, freshness: 0.10 };
export const AUTHORITY_BASE = 0.3;      // assumption: a feed with no history starts here
export const HALF_LIFE_DAYS = 14;
export const NOVELTY_BOOST = 1.08;

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// Spec formula 1/(1+ln(1+h/12)) did not match its own stated decay (it gives 0.27 at 7 days).
// This curve hits the stated points: 1 at 0 h, 0.5 at 24 h, about 0.1 at 7 d, about 0.05 at 14 d.
export function freshness(hours) {
  const h = Math.max(0, hours);
  return 1 / (1 + Math.pow(h / 24, 1.129));
}

export const squash = (cos) => 1 - Math.exp(-3 * Math.max(0, cos)); // cosine of 0.2 maps to 0.45, 0.5 to 0.78

export function decay(ageMs) { return Math.pow(0.5, ageMs / (HALF_LIFE_DAYS * 86400000)); }

export const AUTHORITY_SIGNALS = { open: 0.15, dwell: 0.10, readNoOpen: -0.05, save: 0.25 };

export function authorityOf(delta) { return clamp(AUTHORITY_BASE + delta); }

export function trainingAdjust(item, rules) {
  let sum = 0;
  for (const r of rules) {
    if (r.type === "feed" && r.key === String(item.feedId)) sum += r.value;
    else if (r.type === "author" && item.author && r.key === item.author.toLowerCase()) sum += r.value;
    else if (r.type === "keyword" && item.stems && item.stems.includes(r.key)) sum += r.value;
    else if (r.type === "tag" && item.tags && item.tags.includes(r.key)) sum += r.value;
  }
  return clamp(sum * 0.08, -0.2, 0.2);
}

export function scoreItem(item, ctx) {
  const w = ctx.weights || DEFAULT_WEIGHTS;
  const tagCos = ctx.centroid ? ctx.cosine(item.vec, ctx.centroid) : 0;
  const tag = squash(tagCos);
  let echoCos = ctx.echo ? ctx.cosine(item.vec, ctx.echo) : 0;
  const visits = (ctx.domainVisits && ctx.domainVisits[item.domain]) || 0;
  if (visits >= 3) echoCos += 0.15;
  const echo = squash(echoCos);
  const authority = authorityOf((ctx.authorityDelta && ctx.authorityDelta[item.feedId]) || 0);
  const fresh = freshness((ctx.now - item.publishedAt) / 3600000);
  const training = trainingAdjust(item, ctx.training || []);
  let raw = w.tag * tag + w.echo * echo + w.authority * authority + w.freshness * fresh + training;
  const novelty = ctx.novelty !== false && ctx.sessionFeeds && !ctx.sessionFeeds.has(item.feedId) ? NOVELTY_BOOST : 1;
  let final = clamp(raw * novelty);
  const enr = ctx.enrichment && ctx.enrichment[item.id];
  if (enr && typeof enr.score === "number") final = clamp(0.8 * final + 0.2 * enr.score);
  return {
    score: Math.round(final * 1000) / 1000,
    breakdown: { tagOverlap: tag, bookmarkEcho: echo, feedAuthority: authority, freshness: fresh, training, noveltyBoost: novelty },
    flag: enr && enr.flag ? enr.flag : null
  };
}

export function normaliseWeights(w) {
  const t = (w.tag + w.echo + w.authority + w.freshness) || 1;
  return { tag: w.tag / t, echo: w.echo / t, authority: w.authority / t, freshness: w.freshness / t };
}

export function whyRanked(b) {
  const parts = [];
  if (b.tagOverlap > 0.6) parts.push("close to your saved tags");
  if (b.bookmarkEcho > 0.6) parts.push("matches sites you read");
  if (b.feedAuthority > 0.55) parts.push("a feed you act on");
  if (b.feedAuthority < 0.2) parts.push("a feed you tend to skip");
  if (b.freshness > 0.7) parts.push("fresh");
  if (b.training > 0.02) parts.push("boosted by your training");
  if (b.training < -0.02) parts.push("lowered by your training");
  if (b.noveltyBoost > 1) parts.push("a feed you have not opened this session");
  return parts.length ? parts.join(", ") : "an average match";
}
