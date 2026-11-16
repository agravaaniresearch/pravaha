// Tests for the 0.8.0 relevance engine (extension/src/scoring.js). Synthetic data only.
// Where the current Pravaha code is present, a few tests also run it to show the defect being fixed; they skip otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../extension/src/scoring.js";

const OLD = null; // the 0.7.0 code these tests compared against is gone; its defects are recorded in docs/RELEVANCE_REVIEW.md
const OLDLOG = null;
const OLDVEC = null;
const OLDTXT = null;

const DAY = 86400000, NOW = Date.UTC(2026, 10, 16, 12);
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const unit = (o) => { let s = 0; for (const k in o) s += o[k] * o[k]; s = Math.sqrt(s); const r = {}; for (const k in o) r[k] = o[k] / s; return r; };
const vecOf = (words) => { const o = {}; for (const w of words) o[w] = (o[w] || 0) + 1; return unit(o); };
const ts = (ms, c = 0, dev = "a") => `${String(Math.max(0, ms)).padStart(14, "0")}.${String(c).padStart(5, "0")}.${dev}`;
let eid = 0; const ev = (type, at, entry, feed, payload, dev = "a") => ({ v: 1, eid: `${dev}:${++eid}`, device: dev, ts: ts(at, eid % 99999, dev), type, entry, feed, payload });
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const expo = (day, feeds, dev = "a") => ev("calibration", Date.parse(day + "T23:00:00Z"), undefined, undefined, { kind: "exposure", day, feeds }, dev);
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

// A firehose (100 articles a day, 2 opened) and a boutique feed (1 a day, opened every day), 60 days, with daily exposure reports.
function firehoseLog({ withExposure = true } = {}) {
  const out = []; let id = 0;
  for (let d = 0; d < 60; d++) {
    const t = NOW - d * DAY - 3600000;
    for (let k = 0; k < 2; k++) out.push(ev("open", t - k * 1000, ++id, 1));
    out.push(ev("open", t - 5000, ++id, 2));
    if (withExposure) out.push(expo(dayStr(t), { 1: 100, 2: 1 }));
  }
  return out;
}

test("defect check: the current standing saturates, so a 2% firehose equals a 100% feed", { skip: !OLD || !OLDLOG }, () => {
  const evs = firehoseLog({ withExposure: false }).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const d = OLDLOG.derive(evs, NOW).authorityDelta;
  assert.equal(OLD.authorityOf(d[1]), 1); assert.equal(OLD.authorityOf(d[2]), 1);
});

test("firehose does not dominate: posterior standing ranks the boutique feed above the firehose", () => {
  const s = P.feedStanding(firehoseLog(), NOW);
  assert.ok(s["2"].value > 0.9, `boutique ${s["2"].value}`);
  assert.ok(s["1"].value < 0.5, `firehose ${s["1"].value}`);
  assert.ok(s["1"].rate < 0.02 && s["2"].rate > 0.3);
  // Without exposure reports neither feed can be told apart by volume, and neither saturates.
  const s0 = P.feedStanding(firehoseLog({ withExposure: false }), NOW);
  assert.ok(s0["1"].value < 0.75 && s0["2"].value < 0.75);
});

test("standing is bounded, neutral at 0.5 for an unknown feed, and finite on empty or junk input", () => {
  assert.equal(P.standingOf(P.feedStanding([], NOW), 42), 0.5);
  assert.equal(P.standingOf(undefined, 42), 0.5);
  const junk = [null, {}, { ts: 5 }, { ts: "abc", type: "open" }, ev("open", NaN, 1, 1), ev("dwell", NOW, 2, 3, { ms: Infinity }), ev("open", NOW + 30 * DAY, 3, 3),
    expo("2026-11-15", { 3: "lots", 4: -7, 5: 1e12 }), { ...expo("bad-day", { 3: 4 }) }];
  const s = P.feedStanding(junk, NOW);
  for (const [k, v] of Object.entries(s)) if (k !== "_mean") { assert.ok(Number.isFinite(v.value) && v.value > 0 && v.value < 1, `${k} ${v.value}`); }
  assert.ok(Number.isFinite(s._mean));
});

test("standing is monotone: one more engaged article raises it, one more ignored article lowers it", () => {
  const base = [expo("2026-11-15", { 1: 20, 2: 20 }), ev("open", NOW - DAY, 1, 1), ev("open", NOW - DAY, 2, 2)];
  const s0 = P.feedStanding(base, NOW)["1"].value;
  const up = P.feedStanding([...base, ev("save", NOW - DAY, 3, 1)], NOW)["1"].value;
  const down = P.feedStanding([...base, expo("2026-11-15", { 1: 40 }, "b")], NOW)["1"].value;
  assert.ok(up > s0 && down < s0, `${down} < ${s0} < ${up}`);
});

test("undo is exact: save then unsave, or dismiss then undismiss, leaves standing as it was (the old code left a net penalty)", () => {
  const base = [expo("2026-11-15", { 7: 30 }), ev("open", NOW - 2 * DAY, 1, 7)];
  const looked = (at) => P.feedStanding([...base, ev("card", at, 2, 7)], NOW)["7"].value; // article 2 was looked at, nothing more
  const saveUnsave = P.feedStanding([...base, ev("card", NOW - 28 * DAY, 2, 7), ev("save", NOW - 28 * DAY, 2, 7), ev("unsave", NOW, 2, 7)], NOW)["7"].value;
  const dismissUndo = P.feedStanding([...base, ev("card", NOW - DAY, 2, 7), ev("dismiss", NOW - DAY, 2, 7), ev("undismiss", NOW, 2, 7)], NOW)["7"].value;
  assert.equal(saveUnsave, looked(NOW - 28 * DAY)); assert.equal(dismissUndo, looked(NOW - DAY));
  if (OLDLOG) assert.ok(OLDLOG.derive([ev("save", NOW - 28 * DAY, 2, 7), ev("unsave", NOW, 2, 7)], NOW).authorityDelta["7"] < -0.18, "old: save 28 days ago, unsave now nets -0.19");
});

test("merge safety: standing is a function of the event SET (any order, duplicates from two machines, exposure merged by max)", () => {
  const a = firehoseLog(), b = [ev("save", NOW - 3 * DAY, 9001, 2, {}, "b"), expo(dayStr(NOW - DAY), { 1: 100, 2: 1 }, "b")];
  const one = P.feedStanding([...a, ...b], NOW), two = P.feedStanding(shuffle([...b, ...a, ...b]), NOW);
  assert.deepEqual(two, one);
  const only = P.feedStanding(a, NOW); assert.equal(one["1"].trials, only["1"].trials, "the second machine's identical exposure report is not double counted");
});

test("dwell values and clock skew stay harmless: huge dwell is one flag, a future event counts as age 0", () => {
  const base = [expo("2026-11-15", { 1: 10 }), ev("open", NOW, 1, 1)];
  const a = P.feedStanding([...base, ev("dwell", NOW, 1, 1, { ms: 16000 })], NOW)["1"].value;
  const b = P.feedStanding([...base, ev("dwell", NOW, 1, 1, { ms: 9e15 }), ev("dwell", NOW, 1, 1, { ms: 9e15 })], NOW)["1"].value;
  assert.equal(a, b);
  const fut = P.feedStanding([expo("2026-11-15", { 1: 10 }), ev("open", NOW + 400 * DAY, 1, 1)], NOW)["1"];
  assert.ok(fut.value < 1 && fut.engaged <= 0.5 + 1e-12);
});

test("freshness uses the published time, distrusts a date later than first seen, and does not bury undated articles", () => {
  assert.equal(P.freshness(P.ageHours({ publishedAt: NOW + 7 * DAY, seenAt: NOW - 48 * 3600000 }, NOW)), P.freshness(48));
  assert.equal(P.freshness(P.ageHours({ publishedAt: NOW + 7 * DAY }, NOW)), 1, "without seenAt the future can only be clamped to now");
  assert.equal(P.freshness(P.ageHours({ publishedAt: 0 }, NOW)), 0.5);
  if (OLD) assert.ok(OLD.scoreItem({ id: 1, feedId: 1, vec: {}, publishedAt: 0 }, { now: NOW, cosine: P.dot }).breakdown.freshness < 1e-4, "old: an undated article is 56 years old");
  let prev = 2; for (let h = 0; h < 2000; h += 7) { const f = P.freshness(P.ageHours({ publishedAt: NOW - 30 * 3600000, seenAt: NOW - 20 * 3600000 }, NOW + h * 3600000)); assert.ok(f <= prev); prev = f; }
});

// ---------- content ----------
const topicWords = (t) => Array.from({ length: 40 }, (_, i) => `t${t}w${i}`);
const gen = Array.from({ length: 2000 }, (_, i) => `g${i}`);
const pick = (arr) => arr[Math.floor(Math.pow(rnd(), 2) * arr.length)];
const doc = (t, n, p) => Array.from({ length: n }, () => (t >= 0 && rnd() < p ? pick(topicWords(t)) : pick(gen)));
function library() { // 8 interests, the first one five times as big as the last
  const profiles = {}, all = [];
  for (let t = 0; t < 8; t++) { const n = Math.round(400 / (1 + t * 0.6)); const vs = []; for (let i = 0; i < n; i++) { const v = vecOf(doc(t, 30, 0.5)); vs.push(v); all.push(v); } const m = {}; for (const v of vs) for (const k in v) m[k] = (m[k] || 0) + v[k]; profiles["topic" + t] = { count: n, vec: unit(m) }; }
  const c = {}; for (const v of all) for (const k in v) c[k] = (c[k] || 0) + v[k];
  return { profiles, centroid: P.mixProfile(unit(c), [], NOW) };
}

test("minority interests are visible: best tag separates an on-topic article from an off-topic one; the mean centroid barely does", () => {
  const { profiles, centroid } = library(); const avg = (f) => { let s = 0; for (let i = 0; i < 100; i++) s += f(); return s / 100; };
  const onC = avg(() => P.dot(vecOf(doc(7, 40, 0.4)), centroid)), offC = avg(() => P.dot(vecOf(doc(-1, 40, 0)), centroid));
  const onT = avg(() => P.bestTag(vecOf(doc(7, 40, 0.4)), profiles).cos), offT = avg(() => P.bestTag(vecOf(doc(-1, 40, 0)), profiles).cos);
  assert.ok(onT - offT > 3 * (onC - offC), `tag gap ${(onT - offT).toFixed(3)} vs centroid gap ${(onC - offC).toFixed(3)}`);
  assert.equal(P.bestTag(vecOf(doc(7, 40, 0.6)), profiles).tag, "topic7");
  assert.deepEqual(P.bestTag({}, profiles), { tag: null, cos: 0 }); assert.deepEqual(P.bestTag(vecOf(["x"]), {}), { tag: null, cos: 0 });
});

test("the interest profile keeps the bookmarks: 300 opens on one topic move at most 30% of it (the old chain erased them)", () => {
  const { centroid } = library(); const pulls = Array.from({ length: 300 }, (_, i) => ({ kind: "open", at: NOW - i * 3600000, vec: vecOf(doc(7, 12, 0.9)) }));
  const mixed = P.mixProfile(centroid, pulls, NOW);
  assert.ok(P.dot(mixed, centroid) > 0.7, `similarity to bookmarks ${P.dot(mixed, centroid)}`); assert.ok(Object.keys(mixed).length <= 500);
  if (OLDVEC) { let c = centroid; for (const p of pulls) c = OLDVEC.blend(c, p.vec, 0.05); assert.ok(OLDVEC.cosine(c, centroid) < 0.3, "old: chained blends drift away"); assert.ok(Object.keys(c).length > 500, "old: and the 500-term prune no longer holds"); }
  assert.deepEqual(P.mixProfile({}, [], NOW), {}); assert.deepEqual(P.mixProfile(centroid, pulls, NOW), mixed, "deterministic");
});

// ---------- hot ----------
test("hot: the same story in four feeds is found, a feed repeating itself is not, nor are stories days apart or unrelated", () => {
  const story = ["agni", "mirv", "drdo", "test", "launch", "odisha", "warhead", "missile"]; const items = []; let id = 0;
  for (let f = 1; f <= 4; f++) items.push({ id: ++id, feedId: f, publishedAt: NOW - f * 3600000, vec: vecOf([...shuffle(story).slice(0, 7), ...doc(-1, 5, 0)]) }); // rewritten copies: 7 of 8 story words
  items.push({ id: ++id, feedId: 1, publishedAt: NOW - 2 * 3600000, vec: vecOf([...story.slice(0, 6), ...doc(-1, 6, 0)]) }); // feed 1 again
  items.push({ id: ++id, feedId: 9, publishedAt: NOW - 5 * DAY, vec: vecOf([...story.slice(0, 6), ...doc(-1, 6, 0)]) });   // days earlier
  for (let i = 0; i < 300; i++) items.push({ id: ++id, feedId: 10 + (i % 50), publishedAt: NOW - rnd() * 2 * DAY, vec: vecOf(doc(i % 8, 20, 0.3)) });
  const h = P.hotness(items);
  for (let i = 1; i <= 4; i++) assert.equal(h.get(i).others, 3, `story item ${i}`);
  assert.equal(h.get(5).others, 3, "feed 1's second copy sees feeds 2..4, never itself"); assert.equal(h.get(6).others, 0, "five days earlier is a different news cycle");
  const noise = [...h.entries()].filter(([k]) => k > 6).map(([, v]) => v.others); assert.ok(noise.filter(x => x > 0).length / noise.length < 0.05, "few false clusters in topical noise");
  assert.deepEqual(P.hotness(shuffle(items)), h, "order of input does not matter"); assert.equal(P.hotness([]).size, 0);
  assert.ok(P.hotSignal(0) === 0 && P.hotSignal(1) < P.hotSignal(2) && P.hotSignal(50) === 1);
});

// ---------- the score ----------
function ctxFor(extra = {}) { const { profiles, centroid } = library(); return { weights: P.DEFAULT_WEIGHTS, centroid, profiles, echo: centroid, domainVisits: {}, training: [], now: NOW, sessionFeeds: new Set([1]), novelty: true, ...extra }; }

test("score is bounded, finite and never throws, whatever is missing or malformed", () => {
  const ctxs = [{}, { now: NaN }, { centroid: {}, echo: {}, profiles: {} }, ctxFor(), ctxFor({ weights: { tag: NaN, echo: -4 }, training: [{ type: "feed", key: "1", value: NaN }, { type: "feed", key: "1", value: 1e9 }], enrichment: { 1: { score: NaN } }, k: NaN })];
  const items = [{ id: 1, feedId: 1 }, { id: 1, feedId: 1, vec: {}, publishedAt: NaN }, { id: 1, feedId: 2, vec: vecOf(topicWords(0)), publishedAt: NOW + 9 * DAY, stems: [], tags: [] }];
  for (const c of ctxs) for (const it of items) { const r = P.scoreItem(it, c); assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 1, JSON.stringify(r)); for (const [k, v] of Object.entries(r.breakdown)) if (typeof v === "number") assert.ok(Number.isFinite(v), k); }
  if (OLD) assert.throws(() => OLD.scoreItem({ id: 1, feedId: 1 }, { centroid: { a: 1 }, cosine: (a, b) => OLDVEC.cosine(a, b), now: NOW }), "old: a missing vector throws");
});

test("score is monotone in each signal", () => {
  const c = ctxFor({ sessionFeeds: new Set([1, 2]) }); const it = { id: 5, feedId: 2, vec: vecOf(doc(3, 30, 0.2)), publishedAt: NOW - 30 * 3600000, stems: ["navy"], domain: "x.in" };
  const s = (i, cx = c) => P.scoreItem(i, cx).score;
  assert.ok(s({ ...it, vec: vecOf(doc(3, 30, 0.6)) }) >= s(it), "more on-topic");
  assert.ok(s({ ...it, publishedAt: NOW - 3600000 }) >= s(it), "fresher");
  assert.ok(s(it, { ...c, standing: { 2: { value: 0.9 } } }) >= s(it, { ...c, standing: { 2: { value: 0.4 } } }), "better feed");
  assert.ok(s(it, { ...c, hot: new Map([[5, { others: 3 }]]) }) >= s(it, { ...c, hot: new Map([[5, { others: 1 }]]) }), "hotter");
  assert.ok(s(it, { ...c, training: [{ type: "keyword", key: "navy", value: 1 }] }) > s(it), "trained up");
  let prev = -1; for (let v = 0; v < 60; v++) { const x = s(it, { ...c, domainVisits: { "x.in": v } }); assert.ok(x >= prev, "domain visits, smooth and monotone"); prev = x; }
  for (let v = 0; v < 200; v++) assert.ok(P.domainBonus(v + 1) >= P.domainBonus(v));
});

test("deterministic: same inputs, same score and breakdown, on repeat and with a fresh profiles object", () => {
  const c = ctxFor(); const it = { id: 5, feedId: 2, vec: vecOf(doc(2, 30, 0.4)), publishedAt: NOW - 5 * 3600000 };
  const a = P.scoreItem(it, c); assert.deepEqual(P.scoreItem(it, c), a); assert.deepEqual(P.scoreItem(it, { ...c, profiles: structuredClone(c.profiles) }), a);
});

test("weights: a stored 0.7.0 four-weight object still works, junk falls back to defaults, the result always sums to 1", () => {
  for (const w of [{ tag: 0.4, echo: 0.3, authority: 0.2, freshness: 0.1 }, { tag: NaN, echo: -1 }, {}, null, { tag: 0, echo: 0, authority: 0, freshness: 0, hot: 0 }]) {
    const n = P.normaliseWeights(w); const sum = Object.values(n).reduce((a, b) => a + b, 0); assert.ok(Math.abs(sum - 1) < 1e-12, JSON.stringify(n)); assert.ok(Object.values(n).every(x => x >= 0));
  }
  if (OLD) assert.ok(Number.isNaN(OLD.normaliseWeights({ tag: 1, authority: 1, freshness: 1 }).echo), "old: a missing weight becomes NaN and every score 0");
});

test("display: the odds stretch is strictly increasing and never clips (the old 0.65 stretch shows 0.66 and 0.95 the same)", () => {
  let prev = -1; for (let s = 0; s <= 1.0001; s += 0.01) { const d = P.displayOf(s); assert.ok(d > prev || s === 0); prev = d; }
  assert.ok(P.displayOf(0.66) < P.displayOf(0.95) && P.displayOf(0.95) < 1); assert.equal(P.displayOf(NaN), 0);
});

test("text: entities do not become words, designators survive, US is kept", { skip: !OLDTXT }, () => {
  const raw = "India&rsquo;s F-35 and S-400 &mdash; the US &amp; MQ-9B deal";
  assert.ok(OLDTXT.tokenize(raw).includes("rsquo") && !OLDTXT.tokenize(raw).some(t => /35|400/.test(t)), "old: junk in, designators out");
  const t = OLDTXT.tokenize(P.prepText(raw));
  for (const w of ["f35", "s400", "mq9b", "usa", "deal"]) assert.ok(t.includes(w), w); assert.ok(!t.includes("rsquo") && !t.includes("mdash") && !t.includes("amp"));
});

test("benchmark: 3,000 articles against a 500-term profile and 300 tag profiles, plus hot clustering and standing", () => {
  const vocab = Array.from({ length: 20000 }, (_, i) => "w" + i); const prof = {}; for (let i = 0; i < 500; i++) prof[vocab[Math.floor(rnd() * 3000)]] = rnd();
  const centroid = unit(prof), profiles = {}; for (let t = 0; t < 300; t++) { const o = {}; for (let i = 0; i < 120; i++) o[vocab[Math.floor(rnd() * 5000)]] = rnd(); profiles["tag" + t] = { count: 2 + (t % 40), vec: unit(o) }; }
  const items = Array.from({ length: 3000 }, (_, i) => { const o = {}; for (let k = 0; k < 40; k++) o[vocab[Math.floor(Math.pow(rnd(), 1.5) * 20000)]] = 1 + rnd(); return { id: i, feedId: i % 200, vec: unit(o), stems: Object.keys(o).slice(0, 12), publishedAt: NOW - rnd() * 3 * DAY, domain: "d" + (i % 200) }; });
  const ctx = { centroid, echo: centroid, profiles, domainVisits: { d1: 5 }, training: [{ type: "keyword", key: "w3", value: 1 }, { type: "feed", key: "7", value: -1 }], now: NOW, sessionFeeds: new Set(), novelty: true };
  P.bestTag(items[0].vec, profiles); // build the index once, as the engine would per model
  const best = (f) => { let m = Infinity; for (let r = 0; r < 5; r++) { const t = performance.now(); f(); m = Math.min(m, performance.now() - t); } return m; };
  const evs = []; for (let i = 0; i < 20000; i++) evs.push(ev(["open", "card", "dwell", "save", "dismiss"][i % 5], NOW - rnd() * 90 * DAY, i, i % 200, { ms: 20000 }));
  for (let d = 0; d < 90; d++) { const f = {}; for (let k = 0; k < 200; k++) f[k] = 1 + (k % 30); evs.push(expo(dayStr(NOW - d * DAY), f)); }
  const st = P.feedStanding(evs, NOW), hot = P.hotness(items);
  const tScore = best(() => { for (const it of items) P.scoreItem(it, { ...ctx, standing: st, hot }); });
  const tHot = best(() => P.hotness(items)), tStand = best(() => P.feedStanding(evs, NOW));
  console.log(`# bench: score 3000 = ${tScore.toFixed(1)} ms, hotness 3000 = ${tHot.toFixed(1)} ms, feedStanding 20,090 events = ${tStand.toFixed(1)} ms`);
  assert.ok(tScore < 100, `scoring took ${tScore} ms`); assert.ok(tHot < 200, `hotness took ${tHot} ms`);
});

test("a signal with no source gives its weight away instead of capping the score (old: no history meant a 0.7 ceiling)", () => {
  const w = P.normaliseWeights(P.DEFAULT_WEIGHTS, { echo: false, hot: false }); assert.equal(w.echo, 0); assert.equal(w.hot, 0); assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b) - 1) < 1e-12);
  const v = vecOf(["navy", "ship", "frigate"]); const it = { id: 1, feedId: 1, vec: v, publishedAt: NOW };
  const best = P.scoreItem(it, { centroid: v, now: NOW, standing: { 1: { value: 0.99 } }, novelty: false }).score;
  assert.ok(best > 0.9, `best possible article without history scores ${best}`);
  if (OLD) assert.ok(OLD.scoreItem(it, { weights: OLD.DEFAULT_WEIGHTS, centroid: v, now: NOW, authorityDelta: { 1: 5 }, cosine: P.dot, novelty: false }).score < 0.7);
});

test("exposure payload: counts one UTC day per feed and round-trips through feedStanding", () => {
  const day = Date.UTC(2026, 10, 15); const items = [{ feedId: 1, publishedAt: day + 1000 }, { feedId: 1, publishedAt: day + 5 * 3600000 }, { feedId: 2, publishedAt: day - 1 }];
  const p = P.exposurePayload(items, day); assert.deepEqual(p, { kind: "exposure", day: "2026-11-15", feeds: { 1: 2 } }); assert.equal(P.exposurePayload(items, NaN), null);
  const s = P.feedStanding([ev("calibration", day + DAY, undefined, undefined, p)], NOW); assert.ok(s["1"].trials > 1.9 && s["1"].value < 0.5);
});
