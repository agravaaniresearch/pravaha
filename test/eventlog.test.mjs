import test from "node:test";
import assert from "node:assert/strict";
import { Clock, EventLog, derive, fmtTs, parseTs, parseSegment, toSegmentText, validEvent, SEGMENT_SIZE } from "../extension/src/eventlog.js";

const mk = (dev, now) => new EventLog(dev, new Clock(dev, () => now.t));
test("timestamps format and parse, and sort lexicographically", () => {
  const a = fmtTs(5, 0, "m1"), b = fmtTs(5, 1, "m1"), c = fmtTs(6, 0, "m1");
  assert.ok(a < b && b < c); assert.deepEqual(parseTs(b), { wall: 5, counter: 1, device: "m1" });
});
test("clock never goes backwards even when the wall clock does", () => {
  const now = { t: 1000 }; const clk = new Clock("a", () => now.t);
  const t1 = clk.tick(); now.t = 500; const t2 = clk.tick(); const t3 = clk.tick();
  assert.ok(t1 < t2 && t2 < t3);
});
test("clock observes a remote timestamp from the future and stays ahead of it", () => {
  const now = { t: 1000 }; const clk = new Clock("a", () => now.t);
  clk.observe(fmtTs(9000, 3, "b")); assert.ok(clk.tick() > fmtTs(9000, 3, "b"));
});
test("append assigns increasing sequence numbers and merge ignores duplicates and invalid events", () => {
  const now = { t: 1 }; const a = mk("a", now); const e1 = a.append("open", { entry: 1, feed: 1 }); a.append("save", { entry: 1, feed: 1 });
  const b = mk("b", now);
  assert.equal(b.merge([e1, e1, { eid: "x" }, null, { ...e1, eid: "z:1", type: "bogus" }]), 1); assert.equal(b.count(), 1);
});
test("merge is order independent: any shuffle of two logs gives the same derived state", () => {
  const now = { t: 1700000000000 }; const a = mk("a", now), b = mk("b", now);
  for (let i = 0; i < 30; i++) { now.t += 1000; (i % 2 ? a : b).append(["open", "dismiss", "save", "unsave", "dwell"][i % 5], { entry: i % 7, feed: i % 3, payload: { ms: 20000, terms: ["navy"] } }); }
  const all = [...a.list(), ...b.list()];
  let ref = null;
  for (let s = 0; s < 25; s++) {
    const shuffled = all.slice().sort(() => Math.random() - 0.5); const l = mk("c", now); for (let i = 0; i < shuffled.length; i += 7) l.merge(shuffled.slice(i, i + 7));
    const d = JSON.stringify(derive(l.list(), now.t + 5000), (k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v].sort() : v));
    if (ref === null) ref = d; else assert.equal(d, ref);
  }
});
test("derive: dismiss then undismiss, save then unsave, authority and training last-write-wins", () => {
  const now = { t: 1700000000000 }; const l = mk("a", now);
  const t = (type, f) => { now.t += 10; l.append(type, f); };
  t("dismiss", { entry: 1, feed: 1 }); t("undismiss", { entry: 1, feed: 1 }); t("dismiss", { entry: 2, feed: 1 });
  t("save", { entry: 3, feed: 2 }); t("save", { entry: 4, feed: 2 }); t("unsave", { entry: 4, feed: 2 });
  t("train", { payload: { type: "feed", key: "1", value: 1 } }); t("train", { payload: { type: "feed", key: "1", value: 0 } }); t("train", { payload: { type: "keyword", key: "navy", value: -1 } });
  t("open", { entry: 3, feed: 2 }); t("dwell", { entry: 3, feed: 2, payload: { ms: 30000 } }); t("dwell", { entry: 3, feed: 2, payload: { ms: 5000 } });
  const d = derive(l.list(), now.t);
  assert.deepEqual([...d.dismissed], [2]); assert.deepEqual([...d.saved], [3]);
  assert.deepEqual(d.training, [{ type: "keyword", key: "navy", value: -1 }]);
  assert.equal(d.dwell.get(3), 35000); assert.equal(d.opens.get(3), 1);
  assert.ok(d.authorityDelta["2"] > 0.3 && d.authorityDelta["2"] < 0.5, "save 0.25 + open 0.15 + dwell 0.10 minus the unsaved one");
  assert.ok(d.authorityDelta["1"] < 0);
});
test("old signals fade: the same open counts for half after 14 days", () => {
  const l = mk("a", { t: 1700000000000 }); l.append("open", { entry: 1, feed: 1 });
  const fresh = derive(l.list(), 1700000000000).authorityDelta["1"], later = derive(l.list(), 1700000000000 + 14 * 86400000).authorityDelta["1"];
  assert.ok(Math.abs(later - fresh / 2) < 1e-6);
});
test("segments round-trip and tolerate corrupt lines", () => {
  const l = mk("a", { t: 5 }); l.append("open", { entry: 1 }); l.append("save", { entry: 1 });
  const text = toSegmentText(l.list()) + "{broken json\n" + JSON.stringify({ eid: "a:9" }) + "\n";
  const r = parseSegment(text); assert.equal(r.events.length, 2); assert.equal(r.corrupt, 2);
  assert.deepEqual(parseSegment("").events, []); assert.ok(validEvent(r.events[0]) && SEGMENT_SIZE === 500);
});
