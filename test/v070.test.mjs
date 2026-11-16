// 0.7.0: training in plain sight. A thumb on an article, clickable tags and words, the Raindrop context, and the two bundled fonts. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { world, entry } from "./helpers.mjs";
import { canonicalUrl } from "../extension/src/text.js";
import { derive, EVENT_TYPES } from "../extension/src/eventlog.js";
import { buildDigest } from "../extension/src/digest.js";
import { makeHandlers } from "../extension/src/handlers.js";
import { suggestTags, buildTagProfiles } from "../extension/src/tagger.js";
import { Corpus, cosine } from "../extension/src/vector.js";
import { tokenize } from "../extension/src/text.js";

const quiet = (e) => { for (const t of e._timers) clearTimeout(t); e._timers.clear(); };
const scoreOf = (e, id) => e.scoreRow(id).score;
const ready = async (extraBookmarks = []) => { const w = await world(); w.rd.st.bookmarks.push(...extraBookmarks); const a = await w.mk("laptop"); await a.e.syncNow(); quiet(a.e); return { w, a, e: a.e }; };
const SAVED = { _id: 900, title: "Navy orders new frigates", excerpt: "frigate shipyard procurement", note: "Read this before the budget talk", tags: ["defence", "frigates"], link: "https://www.site1.example/1/?utm_source=newsletter#top", lastUpdate: "2026-03-12T00:00:00Z" };

test("one page has one address: scheme, www, fragment, tracking parameters and a trailing slash are ignored, real parameters are kept", () => {
  assert.equal(canonicalUrl("https://www.Example.com/a/b/?utm_source=x&id=7&fbclid=z#frag"), "example.com/a/b?id=7");
  assert.equal(canonicalUrl("http://example.com/a/b"), canonicalUrl("https://www.example.com/a/b/"));
  assert.notEqual(canonicalUrl("https://example.com/a?id=1"), canonicalUrl("https://example.com/a?id=2"));
  assert.equal(canonicalUrl("javascript:alert(1)"), ""); assert.equal(canonicalUrl("not a url"), ""); assert.equal(canonicalUrl(null), "");
});

test("the Raindrop copy keeps each link, and a copy made before links were kept is fetched again at once", async () => {
  const { w, e } = await ready([SAVED]);
  assert.equal(e.raindropCache.v, 3); assert.ok(e.raindropCache.bookmarks.every(b => typeof b.link === "string" && b.link.startsWith("http")), "every saved page carries its link");
  const before = w.rd.st.bookmarks.length; e.raindropCache = { at: Date.now(), bookmarks: e.raindropCache.bookmarks.map(({ link, ...rest }) => rest) };
  await e.refreshRaindrop(); assert.equal(e.raindropCache.v, 3, "an old shape is replaced even though it is fresh"); assert.equal(e.raindropCache.bookmarks.length, before); assert.ok(e.raindropCache.bookmarks[0].link);
});

test("the trainer for an article lists your own Raindrop tags first, then suggested ones, with the words that carry the title", async () => {
  const { e } = await ready([SAVED]); const t = e.trainerFor(1);
  assert.deepEqual(t.tags.slice(0, 2).map(x => [x.tag, x.source]), [["defence", "raindrop"], ["frigates", "raindrop"]], "your own save of this very page comes first");
  assert.ok(t.tags.length <= 6 && new Set(t.tags.map(x => x.key)).size === t.tags.length, "no duplicates and a short list");
  assert.ok(t.words.some(w => w.word === "frigates" && w.key === "frigate"), "the word is shown as written and trained as its stem");
  assert.equal(t.raindrop.exact.title, "Navy orders new frigates"); assert.equal(t.raindrop.exact.note, "Read this before the budget talk"); assert.deepEqual(t.raindrop.exact.tags, ["defence", "frigates"]);
  assert.ok(t.raindrop.related.length >= 1 && t.raindrop.related.every(r => r.sim >= 0.22), "related saves are close enough to mean something");
  assert.equal(e.trainerFor(404), null, "an unknown article gives nothing");
});

test("an article you never saved has no exact copy, but still shows the closest saves; with no Raindrop token it says so and shows nothing", async () => {
  const { e } = await ready(); const t = e.trainerFor(2);
  assert.equal(t.raindrop.exact, null); assert.equal(t.raindrop.configured, true);
  const w = await world(); const b = await w.mk("nokey", { raindrop: { token: "" } }); await b.e.syncNow(); quiet(b.e); const t2 = b.e.trainerFor(1);
  assert.equal(t2.raindrop.configured, false); assert.equal(t2.raindrop.count, 0); assert.deepEqual(t2.raindrop.related, []); assert.deepEqual(t2.tags.filter(x => x.source !== "feed"), []);
});

test("keyword training now matches: the old raw word never did, the stem does (fixes a silent no-op for plurals)", async () => {
  const { e } = await ready(); const base = scoreOf(e, 1);
  await e.train("keyword", "frigates", 1); assert.equal(scoreOf(e, 1), base, "a raw plural matches no stem, so nothing changed before");
  await e.train("keyword", "frigates", 0); await e.train("keyword", "frigate", 1); assert.ok(scoreOf(e, 1) > base, "the stem is what the engine matches");
});

test("a tag rule moves the score of articles it fits and leaves the others alone, using Raindrop tags the feed never sent", async () => {
  const { e } = await ready(); const n1 = scoreOf(e, 1), k = scoreOf(e, 2);
  assert.ok(e.trainerFor(1).tags.some(t => t.key === "defence"), "the vocabulary suggests defence for the naval article");
  await e.train("tag", "Defence", -1); assert.ok(scoreOf(e, 1) < n1, "lowered"); assert.equal(scoreOf(e, 2), k, "the kitchen article is untouched");
  await e.train("tag", "defence", 1); assert.ok(scoreOf(e, 1) > n1, "and raised, whatever the capital letters");
  await e.train("tag", "defence", 0); assert.equal(scoreOf(e, 1), n1, "clearing the rule restores the score exactly");
});

test("a thumbs up trains the top tags and words, raises the score, shows on the row, and the same thumb again takes it all back", async () => {
  const { e } = await ready([SAVED]); const base = scoreOf(e, 1);
  const r = await e.rateStory(1, 1); assert.equal(r.ok, true); assert.ok(r.score > base, "the new score comes back with the answer"); assert.ok(r.labels.includes("#defence")); assert.ok(r.labels.length <= 6);
  assert.equal(e.trainerFor(1).story, 1); const view = e.getView({ scope: "all", mode: "all" }); const row = view.groups.flatMap(g => g.rows).find(x => x.id === 1); assert.equal(row.rating, 1);
  assert.ok(e.trainingRules().some(x => x.type === "tag" && x.key === "defence" && x.value === 0.3), "a thumb carries 0.3 of a full click"); assert.ok(e.trainingRules().every(x => x.type !== "story"), "the thumb itself is not shown as a rule");
  await e.rateStory(1, 0); assert.equal(scoreOf(e, 1), base, "exactly back"); assert.deepEqual(e.trainingRules(), []); assert.equal(e.trainerFor(1).story, 0);
});

test("switching from up to down leaves nothing of the up behind, and a rule you set by hand afterwards survives taking the thumb back", async () => {
  const { e } = await ready([SAVED]); await e.rateStory(1, 1); await e.rateStory(1, -1);
  assert.ok(e.trainingRules().length > 0 && e.trainingRules().every(x => x.value < 0), "only the down rules remain");
  await e.train("tag", "defence", 1); await e.rateStory(1, 0);
  assert.deepEqual(e.trainingRules().map(x => [x.type, x.key, x.value]), [["tag", "defence", 1]], "the hand-set rule stays; the thumb's own are gone");
});

test("a thumb leaves room for a tag click: after a thumbs up, one tag set to less still lowers the score", async () => {
  const { e } = await ready([SAVED]); await e.rateStory(1, 1); const up = scoreOf(e, 1); await e.train("tag", "defence", -1); assert.ok(scoreOf(e, 1) < up, "the click is not swallowed by the cap");
  const rules = e.trainingRules().length; assert.ok(rules >= 4); assert.ok(0.08 * (0.3 * (rules - 1) + 1) > 0 && 0.08 * 0.3 * rules <= 0.2, "six thumb rules stay under the 0.2 cap");
});
test("a thumbs up also nudges the interest profile; a thumbs down does not; taking the thumb back removes the nudge", async () => {
  const { e } = await ready([SAVED]); const pulls = () => derive(e.log.list(), Date.now()).pulls.filter(p => p.kind === "up").length;
  assert.equal(pulls(), 0); await e.rateStory(1, 1); assert.equal(pulls(), 1); await e.rateStory(1, -1); assert.equal(pulls(), 0, "down is not a pull"); await e.rateStory(1, 1); await e.rateStory(1, 0); assert.equal(pulls(), 0);
});

test("only known event types are written, so a copy of Pravaha from before this version still reads every event", async () => {
  const { e } = await ready([SAVED]); await e.rateStory(1, 1); await e.train("tag", "x", -1); await e.rateStory(2, -1);
  assert.ok(e.log.list().every(ev => EVENT_TYPES.has(ev.type))); assert.ok(e.log.list().filter(ev => ev.payload && ev.payload.type === "story").every(ev => ev.type === "train"));
});

test("a thumb is refused for an unknown article, and a wrong value or an empty key writes nothing", async () => {
  const { e } = await ready(); const n = e.log.count();
  assert.deepEqual(await e.rateStory(999, 1), { ok: false }); assert.deepEqual(await e.rateStory(1, 5), { ok: false });
  await e.trainMany([{ type: "tag", key: "", value: 1 }, { type: "tag", key: "a", value: 9 }, { type: "tag", key: "b", value: "x" }, null, { type: 7, key: "c", value: 1 }]); assert.equal(e.log.count(), n);
});

test("training travels to another machine through the history log, thumb included", async () => {
  const w = await world(); const a = await w.mk("laptop"); await a.e.syncNow(); quiet(a.e); await a.e.rateStory(1, 1); await a.e.syncNow(); quiet(a.e);
  const b = await w.mk("home"); await b.e.syncNow(); quiet(b.e);
  assert.deepEqual(b.e.trainingRules().map(x => `${x.type}:${x.key}:${x.value}`).sort(), a.e.trainingRules().map(x => `${x.type}:${x.key}:${x.value}`).sort());
  assert.equal(b.e.trainerFor(1).story, 1, "the other machine shows the thumb pressed"); assert.equal(scoreOf(b.e, 1), scoreOf(a.e, 1), "and ranks the article the same");
});

test("the handlers answer trainer, rate and score, and a rate request reports plainly when the article is gone", async () => {
  const { e } = await ready(); const h = makeHandlers({ engine: e, fetchImpl: async () => new Response("", { status: 404 }), runSync: async () => {}, schedule: async () => {}, openTab: async () => {} });
  assert.equal((await h.trainer({ id: 1 })).id, 1); assert.ok(Number.isFinite((await h.score({ id: 1 })).score)); assert.equal((await h.rate({ id: 1, value: 1 })).ok, true); assert.deepEqual(await h.rate({ id: 4040, value: 1 }), { ok: false });
});

test("the digest says what you trained and which articles you already saved in Raindrop", async () => {
  const { w, e } = await ready([SAVED]); w.mf.st.entries.find(x => x.id === 1).published_at = new Date().toISOString(); await e.syncNow(); quiet(e);
  await e.rateStory(1, 1); await e.train("tag", "recipes", -1); const r = await e.writeDigest();
  assert.match(r.md, /## What you trained/); assert.match(r.md, /- More of: .*#defence/); assert.match(r.md, /- Less of: .*#recipes/); assert.match(r.md, /saved in Raindrop/);
  const bare = buildDigest({ now: Date.now(), week: "2026-W46", top: [], saved: [], authority: [], centroidTerms: [], trained: { more: [], less: [] } }); assert.match(bare, /No training yet/);
});

test("scoring with tag rules stays quick on a big shelf, and costs nothing without them", async () => {
  const { w, e } = await ready(); for (let i = 0; i < 1500; i++) w.mf.st.entries.push(entry(500 + i, 1 + (i % 3), `Synthetic story ${i} about ships and budgets`, "Frigates and tax receipts in the news.", 1 + (i % 40))); await e.syncNow(); quiet(e);
  const t0 = performance.now(); e.getView({ scope: "all", mode: "all" }); const plain = performance.now() - t0;
  await e.train("tag", "defence", 1); const t1 = performance.now(); e.getView({ scope: "all", mode: "all" }); const withRule = performance.now() - t1;
  const t2 = performance.now(); e.getView({ scope: "all", mode: "all" }); const again = performance.now() - t2;
  assert.ok(withRule < 1500, `first view with a tag rule ${Math.round(withRule)} ms`); assert.ok(again < Math.max(250, plain * 3), `later views reuse the tags: ${Math.round(again)} ms`);
});

test("only the two Apple families are bundled: no other font file, face or licence ships in the extension", () => {
  const dir = new URL("../extension/ui/fonts/", import.meta.url); const here = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f !== "apple") : []; // a clean checkout (and CI) has no fonts folder at all
  assert.deepEqual(here, [], "no font file outside the git-ignored apple folder");
  const css = fs.readFileSync(new URL("../extension/ui/reader.css", import.meta.url), "utf8"); const fams = [...css.matchAll(/@font-face\s*\{\s*font-family:\s*"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fams)].sort(), ["Pravaha New York", "Pravaha SF Pro"]); assert.ok(!/serif-newsreader|ui-plex|serif-literata|ui-ubuntu/.test(css), "no leftover variable names");
  const apple = new URL("../extension/ui/fonts/apple/", import.meta.url); if (fs.existsSync(apple)) assert.ok(fs.readdirSync(apple).reduce((n, f) => n + fs.statSync(new URL(f, apple)).size, 0) < 400 * 1024, "the two families together stay under 400 KB");
});

test("the indexed tag suggestion gives the same tags, order and scores as the plain pair-by-pair formula", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const vocab = Array.from({ length: 120 }, (_, i) => `term${i}`); const pick = (n) => Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ");
  const bms = Array.from({ length: 150 }, (_, i) => ({ title: pick(4), excerpt: pick(8), note: "", tags: [`tag${i % 17}`, `term${i % 9}`, `area-${i % 5}`] }));
  const corpus = new Corpus(); for (const b of bms) corpus.add(tokenize(`${b.title} ${b.excerpt}`));
  const profiles = buildTagProfiles(bms, corpus);
  const plain = (vec, stems, max = 4) => { const set = new Set(stems), out = []; for (const [tag, p] of Object.entries(profiles)) { let sc = cosine(vec, p.vec) * (1 + Math.log10(1 + p.count) * 0.25); if (p.stems.length && p.stems.every(x => set.has(x))) sc += 0.25; if (sc > 0.12) out.push({ tag, score: Math.round(sc * 1000) / 1000 }); } return out.sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1)).slice(0, max); };
  let compared = 0, nonEmpty = 0;
  for (let i = 0; i < 80; i++) { const toks = tokenize(pick(12)); const vec = corpus.vector(toks); const stems = Object.keys(vec).slice(0, 12); const a = suggestTags(vec, stems, profiles), b = plain(vec, stems);
    assert.deepEqual(a.map(x => x.tag), b.map(x => x.tag), `same tags in the same order for sample ${i}`); a.forEach((x, j) => assert.ok(Math.abs(x.score - b[j].score) <= 0.001)); compared++; if (a.length) nonEmpty++; }
  assert.equal(compared, 80); assert.ok(nonEmpty > 20, "the samples really did produce suggestions");
});

test("taking back a thumb that this machine has never seen writes nothing, so it cannot orphan the rules another machine set", async () => {
  const { e } = await ready(); const before = e.log.list().length;
  const r = await e.rateStory(3, 0); assert.equal(r.ok, true); assert.equal(r.value, 0); assert.equal(e.log.list().length, before, "no event was written");
  await e.rateStory(3, 1); assert.ok(e.trainingRules().length > 0); await e.rateStory(3, 0); assert.deepEqual(e.trainingRules(), [], "a thumb that was seen is still taken back exactly"); quiet(e);
});
