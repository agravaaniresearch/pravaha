import test from "node:test";
import assert from "node:assert/strict";
import { Miniflux, feedHealth, splitCategory } from "../extension/src/miniflux.js";
import { Raindrop } from "../extension/src/raindrop.js";
import { Corpus } from "../extension/src/vector.js";
import { tokenize } from "../extension/src/text.js";
import { buildTagProfiles, suggestTags } from "../extension/src/tagger.js";
import { computeStatus, ago } from "../extension/src/status.js";
import { DwellTracker } from "../extension/src/dwell.js";
import { buildOutbox, parseResults } from "../extension/src/enrich.js";
import { buildDigest, isoWeek } from "../extension/src/digest.js";
import { makeMiniflux, makeRaindrop, feed, entry } from "./helpers.mjs";

test("splitCategory nests by slash and tolerates empties", () => {
  assert.deepEqual(splitCategory("Defence/Shipbuilding"), ["Defence", "Shipbuilding"]); assert.deepEqual(splitCategory(" A / / B "), ["A", "B"]); assert.deepEqual(splitCategory(""), ["Uncategorised"]);
});
test("miniflux: auth header, paging, status updates, bookmark toggle, and plain errors", async () => {
  const mf = makeMiniflux(); for (let i = 1; i <= 600; i++) mf.st.entries.push(entry(i, 1, `t${i}`, "x", i / 60));
  const c = new Miniflux({ baseUrl: "https://mf.test/", token: "good-key", fetchImpl: mf.handler });
  assert.equal((await c.me()).username, "ap");
  const all = await c.allUnread(); assert.equal(all.entries.length, 600);
  const capped = await c.allUnread(300); assert.equal(capped.entries.length, 500, "stops after the page that reaches the cap");
  await c.setStatus([1, 2], "read"); assert.equal(mf.st.entries[0].status, "read");
  await c.toggleBookmark(3); assert.equal(mf.st.entries[2].starred, true);
  await assert.rejects(new Miniflux({ baseUrl: "https://mf.test", token: "bad", fetchImpl: mf.handler }).me(), (e) => e.code === "auth" && /API key/.test(e.plain));
  await assert.rejects(new Miniflux({ baseUrl: "https://mf.test", token: "good-key", fetchImpl: async () => { throw new TypeError("x"); } }).me(), (e) => e.code === "unreachable");
  await assert.rejects(new Miniflux({ baseUrl: "https://mf.test", token: "good-key", fetchImpl: async () => new Response("", { status: 500 }) }).me(), (e) => e.code === "bad-reply");
});
test("feedHealth: green, amber on few errors or staleness, red when dead or disabled", () => {
  const now = Date.now();
  assert.equal(feedHealth(feed(1, "a", "x"), now).state, "green");
  assert.equal(feedHealth(feed(1, "a", "x", { parsing_error_count: 2 }), now).state, "amber");
  const dead = feedHealth(feed(1, "a", "x", { parsing_error_count: 5, parsing_error_message: "bad xml" }), now);
  assert.equal(dead.state, "red"); assert.equal(dead.dead, true); assert.match(dead.sentence, /excluded from ranking/);
  assert.equal(feedHealth(feed(1, "a", "x", { disabled: true }), now).dead, true);
  assert.equal(feedHealth(feed(1, "a", "x", { checked_at: new Date(now - 5 * 86400000).toISOString() }), now).state, "amber");
});
test("raindrop: pages through bookmarks, saves one way, and reports a bad token plainly", async () => {
  const bms = Array.from({ length: 120 }, (_, i) => ({ _id: i, title: `b${i}`, excerpt: "", note: "", tags: ["t"], link: `https://s${i % 4}.com/${i}`, lastUpdate: new Date().toISOString() }));
  const rd = makeRaindrop({ bookmarks: bms }); const c = new Raindrop({ token: "rd-token", fetchImpl: rd.handler });
  assert.equal((await c.bookmarks()).length, 120); assert.equal((await c.tags())[0].tag, "t");
  await c.save({ link: "https://a.com", title: "A", tags: ["x"] }); assert.equal(rd.st.saved.length, 1);
  await assert.rejects(new Raindrop({ token: "no", fetchImpl: rd.handler }).tags(), (e) => e.code === "auth");
});
test("tagger suggests tags from your own vocabulary, deterministically, and nothing for unrelated text", () => {
  const bms = [
    { title: "Frigate programme delays", excerpt: "navy shipyard", note: "", tags: ["defence", "shipbuilding"] }, { title: "Destroyer shipyard launch", excerpt: "navy", note: "", tags: ["defence", "shipbuilding"] },
    { title: "Tax budget reform", excerpt: "fiscal deficit", note: "", tags: ["economy"] }, { title: "Interest rates budget", excerpt: "fiscal", note: "", tags: ["economy"] }];
  const c = new Corpus(); const txt = (b) => tokenize(`${b.title} ${b.excerpt}`); bms.forEach(b => c.add(txt(b)));
  const p = buildTagProfiles(bms, c); const stems = tokenize("Navy orders new frigates from shipyard"); const v = c.vector(stems);
  const a = suggestTags(v, stems, p), b = suggestTags(v, stems, p);
  assert.deepEqual(a, b); assert.equal(a[0].tag.includes("ship") || a[0].tag === "defence", true);
  const s2 = tokenize("Recipe for lemon cake"); assert.deepEqual(suggestTags(c.vector(s2), s2, p), []);
});
const base = (o = {}) => ({ now: 1e12, device: "laptop", myHead: null, remoteHeads: {}, others: {}, miniflux: { configured: true, error: null, lastOkAt: 1e12 - 5000 }, webdav: { configured: true, error: null, lastOkAt: 1e12 - 5000 }, raindrop: { configured: true, error: null, lastOkAt: 1e12 - 5000 }, pendingOps: 0, pendingEvents: 0, corruptLines: 0, feeds: { total: 3, dead: 0, trouble: 0 }, ...o });
test("status: all green when nothing is pending", () => { const s = computeStatus(base()); assert.equal(s.overall, "green"); assert.deepEqual(s.left, { events: 0, ops: 0, machines: [] }); });
test("status: pending events make the log amber, a WebDAV error makes it red, with plain sentences", () => {
  assert.equal(computeStatus(base({ pendingEvents: 3 })).overall, "amber");
  const r = computeStatus(base({ pendingEvents: 3, webdav: { configured: true, error: { plain: "Could not reach the WebDAV storage." }, lastOkAt: 1e12 - 7200000 } }));
  assert.equal(r.overall, "red"); assert.match(r.lights.find(l => l.id === "webdav").sentence, /2 hours ago/);
});
test("status: other machine behind or ahead is amber and named; up to date is green", () => {
  const mine = "00000001700000000000.00000.laptop";
  const behind = computeStatus(base({ myHead: mine, others: { desktop: { head: null, appliedHeads: {}, updatedAt: 1e12 - 86400000 } } }));
  assert.equal(behind.lights.find(l => l.id === "machines").state, "amber"); assert.match(behind.lights.find(l => l.id === "machines").sentence, /desktop has not yet received/); assert.equal(behind.left.machines[0].pendingThere, true);
  const ahead = computeStatus(base({ others: { desktop: { head: "00000001700000000999.00000.desktop", appliedHeads: {}, updatedAt: 1e12 } }, remoteHeads: {} }));
  assert.match(ahead.lights.find(l => l.id === "machines").sentence, /has changes this machine has not read yet/);
  const ok = computeStatus(base({ myHead: mine, others: { desktop: { head: "00000001700000000999.00000.desktop", appliedHeads: { laptop: mine }, updatedAt: 1e12 } }, remoteHeads: { desktop: "00000001700000000999.00000.desktop" } }));
  assert.equal(ok.lights.find(l => l.id === "machines").state, "green");
});
test("status: unconfigured services are off, dead feeds are red but do not turn the sync light red", () => {
  const s = computeStatus(base({ miniflux: { configured: false }, webdav: { configured: false }, raindrop: { configured: false }, feeds: { total: 5, dead: 2, trouble: 1 } }));
  assert.equal(s.lights.find(l => l.id === "miniflux").state, "off"); assert.equal(s.lights.find(l => l.id === "feeds").state, "red");
  assert.equal(computeStatus(base({ feeds: { total: 5, dead: 2, trouble: 0 } })).overall, "green");
  assert.equal(ago(10000), "just now"); assert.equal(ago(null), "never"); assert.equal(ago(90000), "2 minutes ago");
});
test("dwell: only counts time while the tab is in front, survives snapshot and restore", () => {
  const d = new DwellTracker(); d.track(1, { id: 9 }, 0, true); d.setActive(2, 10000); d.setActive(1, 20000);
  const snap = JSON.parse(JSON.stringify(d.snapshot())); const e = new DwellTracker(); e.restore(snap);
  const r = e.close(1, 35000); assert.equal(r.ms, 25000); assert.equal(r.meta.id, 9); assert.equal(e.close(1, 40000), null);
  const f = new DwellTracker(); f.track(5, {}, 0, true); f.blur(4000); f.setActive(5, 9000); assert.equal(f.close(5, 10000).ms, 5000);
});
test("enrichment: outbox picks the middle band, results reject out-of-range scores", () => {
  const items = [0.1, 0.3, 0.4, 0.9].map((s, i) => ({ id: i, title: "t", summary: "", url: "u", feedTitle: "f", publishedAt: i, score: s }));
  const out = buildOutbox({ items, centroidTerms: ["navy"], now: 5 }); assert.deepEqual(out.items.map(i => i.id).sort(), [1, 2]);
  const { map, rejected } = parseResults(JSON.stringify({ results: [{ id: 1, score: 0.7, flag: "serendipity" }, { id: 2, score: 1.5 }, { id: "x", score: .3 }, { id: 3, score: "hi" }] }));
  assert.deepEqual(Object.keys(map), ["1"]); assert.equal(rejected, 3); assert.equal(parseResults("garbage").rejected, 1);
});
test("digest: ISO week and front matter, plain markdown", () => {
  assert.equal(isoWeek(Date.UTC(2026, 0, 1)), "2026-W01"); assert.equal(isoWeek(Date.UTC(2026, 11, 31)), "2026-W53");
  const md = buildDigest({ now: Date.UTC(2026, 10, 14), week: "2026-W46", top: [{ title: "A [x] | y", url: "https://a", feedTitle: "F", score: 0.8 }], saved: [], authority: [{ title: "F", value: 0.7 }], centroidTerms: ["navy", "port"], previousTerms: ["navy"] });
  assert.match(md, /^---\ntype: pravaha-digest/); assert.match(md, /80 · \[A x \/ y\]/); assert.match(md, /Nothing saved this week/);
});
