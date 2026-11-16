import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, stem, domainOf, firstParagraph } from "../extension/src/text.js";
import { Corpus, cosine, blend, mean, prune, topTerms, norm } from "../extension/src/vector.js";
import { freshness, squash, decay, authorityOf, trainingAdjust, scoreItem, normaliseWeights, whyRanked, DEFAULT_WEIGHTS, NOVELTY_BOOST } from "../extension/src/scoring.js";

test("tokenize drops stop words, numbers, markup and stems plurals", () => {
  assert.deepEqual(tokenize("The <b>Navy</b> is building 3 new frigates"), ["navy", "build", "frigate"]);
  assert.deepEqual(tokenize(""), []); assert.deepEqual(tokenize(null), []);
  assert.equal(stem("policies"), "policy"); assert.equal(stem("frigates"), stem("frigate")); assert.equal(stem("boxes"), "box"); assert.equal(stem("class"), "class");
});
test("domainOf and firstParagraph", () => {
  assert.equal(domainOf("https://www.example.com/a?b=1"), "example.com"); assert.equal(domainOf("not a url"), "");
  assert.equal(firstParagraph("<p>Hello&nbsp;&amp; <b>world</b></p>"), "Hello & world");
  assert.ok(firstParagraph("x".repeat(500), 100).length <= 100);
});
test("vectors: identical text has cosine 1, disjoint text has 0, vectors are unit length", () => {
  const c = new Corpus(); [["navy", "ship"], ["tax", "budget"], ["navy", "port"]].forEach(t => c.add(t));
  const a = c.vector(["navy", "ship"]), b = c.vector(["navy", "ship"]), d = c.vector(["tax", "budget"]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9); assert.equal(cosine(a, d), 0); assert.ok(Math.abs(norm(a) - 1) < 1e-9);
});
test("blend, mean and prune keep unit length and are deterministic", () => {
  const c = new Corpus(); c.add(["a", "b"]); c.add(["c"]);
  const x = c.vector(["a", "b"]), y = c.vector(["c"]);
  assert.ok(Math.abs(norm(blend(x, y, 0.3)) - 1) < 1e-9);
  assert.deepEqual(mean([x, y], [1, 1]), mean([x, y], [1, 1]));
  assert.deepEqual(mean([], []), {});
  assert.ok(Object.keys(prune({ a: 3, b: 2, c: 1 }, 2)).length === 2);
  assert.deepEqual(topTerms({ b: 1, a: 1, c: 0.5 }, 2), ["a", "b"]);
});
test("freshness hits the stated points of the decay curve", () => {
  assert.equal(freshness(0), 1);
  assert.ok(Math.abs(freshness(24) - 0.5) < 1e-9);
  assert.ok(Math.abs(freshness(168) - 0.1) < 0.005);
  assert.ok(freshness(336) < 0.06 && freshness(336) > 0.04);
  assert.ok(freshness(-5) === 1);
});
test("squash maps cosine 0.2 to about 0.45 and 0.5 to about 0.78", () => {
  assert.ok(Math.abs(squash(0.2) - 0.451) < 0.01); assert.ok(Math.abs(squash(0.5) - 0.777) < 0.01); assert.equal(squash(-1), 0);
});
test("authority decays with a 14 day half life and is clamped", () => {
  assert.ok(Math.abs(decay(14 * 86400000) - 0.5) < 1e-9);
  assert.equal(authorityOf(0), 0.3); assert.equal(authorityOf(5), 1); assert.equal(authorityOf(-5), 0);
});
test("training adjustment is capped at plus or minus 0.2", () => {
  const item = { feedId: 7, author: "Ann", stems: ["navy"], tags: ["defence"] };
  assert.equal(trainingAdjust(item, [{ type: "feed", key: "7", value: 1 }]), 0.08);
  assert.equal(trainingAdjust(item, [{ type: "feed", key: "7", value: 5 }, { type: "keyword", key: "navy", value: 5 }]), 0.2);
  assert.equal(trainingAdjust(item, [{ type: "author", key: "ann", value: -1 }]), -0.08);
  assert.equal(trainingAdjust(item, [{ type: "tag", key: "other", value: 1 }]), 0);
});
function ctxFor(centroid) { return { weights: DEFAULT_WEIGHTS, centroid, echo: centroid, domainVisits: {}, authorityDelta: {}, training: [], now: 1e12, sessionFeeds: new Set([1]), novelty: true, cosine }; }
test("scoreItem is bounded 0..1, rewards relevance and applies the novelty boost only to unseen feeds", () => {
  const c = new Corpus(); c.add(["navy", "ship"]); c.add(["tax"]);
  const centroid = c.vector(["navy", "ship"]);
  const base = { id: 1, feedId: 1, vec: c.vector(["navy", "ship"]), stems: [], domain: "x.com", publishedAt: 1e12 - 3600000 };
  const hit = scoreItem(base, ctxFor(centroid)), miss = scoreItem({ ...base, vec: c.vector(["tax"]) }, ctxFor(centroid));
  assert.ok(hit.score > miss.score); assert.ok(hit.score <= 1 && miss.score >= 0);
  const unseen = scoreItem({ ...base, feedId: 2 }, ctxFor(centroid));
  assert.equal(unseen.breakdown.noveltyBoost, NOVELTY_BOOST); assert.equal(hit.breakdown.noveltyBoost, 1);
  assert.ok(unseen.score >= hit.score);
});
test("external enrichment blends 0.8 local plus 0.2 external", () => {
  const c = new Corpus(); c.add(["a"]); const v = c.vector(["a"]);
  const it = { id: 5, feedId: 1, vec: v, stems: [], domain: "", publishedAt: 1e12 };
  const plain = scoreItem(it, ctxFor(v));
  const enriched = scoreItem(it, { ...ctxFor(v), enrichment: { 5: { score: 0, flag: "serendipity" } } });
  assert.ok(Math.abs(enriched.score - plain.score * 0.8) < 0.002); assert.equal(enriched.flag, "serendipity");
});
test("normaliseWeights sums to one and whyRanked speaks plain prose", () => {
  const w = normaliseWeights({ tag: 2, echo: 1, authority: 1, freshness: 0 });
  assert.ok(Math.abs(w.tag + w.echo + w.authority + w.freshness + w.hot - 1) < 1e-9, "0.8.0: five weights, a stored four-weight object gets the default for hot");
  assert.ok(w.hot > 0 && w.freshness === 0);
  assert.match(whyRanked({ tagOverlap: .9, bookmarkEcho: 0, feedAuthority: .1, freshness: .9, training: .05, noveltyBoost: 1 }), /close to your saved tags.*skip.*fresh.*training/);
  assert.equal(whyRanked({ tagOverlap: .1, bookmarkEcho: .1, feedAuthority: .3, freshness: .1, training: 0, noveltyBoost: 1 }), "an average match");
});
import { gradeColor, disp } from "../extension/src/grade.js";
test("colour grading: stretched display, monotone darkening, readable text colour, unknown palette falls back", () => {
  // 0.8.0: an odds stretch that never clips, so the top of the list stays distinguishable
  assert.equal(disp(0), 0); assert.equal(disp(1), 1); assert.ok(disp(0.9) < 1 && disp(0.9) > disp(0.65)); assert.ok(disp(0.4) > 0.4 && disp(0.4) < 0.5);
  const lum = (c) => { const m = c.bg.match(/\d+/g).map(Number); return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };
  for (const p of ["ember", "saffron", "moss", "kesar", "jade", "sindoor"]) { let prev = Infinity; for (const s of [0, .25, .5, .75, 1]) { const c = gradeColor(s, p); assert.ok(lum(c) <= prev + 1e-9, `${p} ${s}`); prev = lum(c); } }
  assert.equal(gradeColor(0, "ember").fg, "#2b2015"); assert.equal(gradeColor(1, "ember").fg, "#fffaf0"); assert.deepEqual(gradeColor(.5, "nope"), gradeColor(.5, "ember"));
});
