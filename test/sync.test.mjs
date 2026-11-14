import test from "node:test";
import assert from "node:assert/strict";
import { EventLog, Clock, derive } from "../extension/src/eventlog.js";
import { WebDav, PlainError } from "../extension/src/webdav.js";
import { Syncer } from "../extension/src/sync.js";
import { makeDav } from "./helpers.mjs";

const machine = (name, dav, clock) => {
  const log = new EventLog(name, new Clock(name, () => clock.t));
  const wd = new WebDav({ baseUrl: "https://dav.test", user: "u", pass: "p", fetchImpl: dav.handler });
  return { name, log, wd, sy: new Syncer({ dav: wd, log, device: name, now: () => clock.t }) };
};
const stateOf = (m, t) => JSON.stringify(derive(m.log.list(), t), (k, v) => (v instanceof Map ? [...v].sort() : v instanceof Set ? [...v].sort() : v));

test("webdav: URL encoding, 404 as null, auth and network failures give plain sentences", async () => {
  const dav = makeDav(); const wd = new WebDav({ baseUrl: "https://dav.test/", user: "u", pass: "p", fetchImpl: dav.handler });
  assert.equal(wd.url("a b/c"), "https://dav.test/a%20b/c"); assert.equal(await wd.get("nope.txt"), null);
  await wd.mkdirs("x/y"); await wd.put("x/y/f.txt", "hi"); assert.equal(await wd.get("x/y/f.txt"), "hi"); assert.deepEqual(await wd.list("x/y"), ["f.txt"]);
  await wd.mkdirs("x/y");
  const bad = new WebDav({ baseUrl: "https://dav.test", user: "u", pass: "p", fetchImpl: async () => new Response("", { status: 401 }) });
  await assert.rejects(bad.get("a"), (e) => e instanceof PlainError && /app password/.test(e.plain) && e.code === "auth");
  const down = new WebDav({ baseUrl: "https://dav.test", user: "u", pass: "p", fetchImpl: async () => { throw new TypeError("x"); } });
  await assert.rejects(down.get("a"), (e) => e.code === "unreachable" && /Could not reach/.test(e.plain));
  assert.deepEqual(await wd.list("missing"), []);
});

test("two machines converge after taking turns, in either order", async () => {
  const dav = makeDav(); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock), B = machine("desktop", dav, clock);
  for (let i = 0; i < 6; i++) { clock.t += 1000; A.log.append("open", { entry: i, feed: 1, payload: { terms: ["navy"] } }); }
  clock.t += 1000; assert.equal((await A.sy.sync()).ok, true);
  for (let i = 0; i < 4; i++) { clock.t += 1000; B.log.append("dismiss", { entry: 100 + i, feed: 2 }); }
  clock.t += 1000; const rb = await B.sy.sync(); assert.equal(rb.ok, true); assert.equal(rb.pulled, 6);
  clock.t += 1000; const ra = await A.sy.sync(); assert.equal(ra.pulled, 4);
  assert.equal(A.log.count(), 10); assert.equal(B.log.count(), 10); assert.equal(stateOf(A, clock.t), stateOf(B, clock.t));
  assert.equal(A.sy.pending().length, 0);
});

test("offline: events stay pending and are pushed once the network returns", async () => {
  let down = true; const dav = makeDav({ faults: () => (down ? "throw" : null) }); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock);
  A.log.append("open", { entry: 1, feed: 1 }); A.log.append("save", { entry: 1, feed: 1 });
  const r = await A.sy.sync(); assert.equal(r.ok, false); assert.match(r.error.plain, /Could not reach/); assert.equal(A.sy.pending().length, 2);
  down = false; const r2 = await A.sy.sync(); assert.equal(r2.ok, true); assert.equal(A.sy.pending().length, 0);
  assert.ok([...dav.files.keys()].some(k => k.startsWith("pravaha/events/laptop/0000")));
});

test("a failed push is retried and nothing is lost or duplicated", async () => {
  let fail = false; const dav = makeDav({ faults: (m, u) => (fail && m === "PUT" && u.includes("/events/") ? 500 : null) });
  const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock), B = machine("desktop", dav, clock);
  A.log.append("open", { entry: 1, feed: 1 }); fail = true; const r = await A.sy.sync(); assert.equal(r.ok, false); assert.equal(A.sy.pending().length, 1);
  fail = false; assert.equal((await A.sy.sync()).ok, true); assert.equal((await B.sy.sync()).pulled, 1); assert.equal((await B.sy.sync()).pulled, 0);
});

test("more than one segment: 1,250 events become three files and arrive intact", async () => {
  const dav = makeDav(); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock), B = machine("desktop", dav, clock);
  for (let i = 0; i < 1250; i++) { clock.t += 1; A.log.append("dwell", { entry: i % 50, feed: 1, payload: { ms: 1000 } }); }
  assert.equal((await A.sy.sync()).ok, true);
  assert.deepEqual([...dav.files.keys()].filter(k => k.includes("/events/laptop/")).sort(), ["pravaha/events/laptop/0000.jsonl", "pravaha/events/laptop/0001.jsonl", "pravaha/events/laptop/0002.jsonl"]);
  assert.equal((await B.sy.sync()).pulled, 1250);
  A.log.append("open", { entry: 1, feed: 1 }); await A.sy.sync(); assert.equal((await B.sy.sync()).pulled, 1);
});

test("a corrupted segment is skipped line by line and counted, valid lines still merge", async () => {
  const dav = makeDav(); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock), B = machine("desktop", dav, clock);
  A.log.append("open", { entry: 1, feed: 1 }); A.log.append("open", { entry: 2, feed: 1 }); await A.sy.sync();
  const k = "pravaha/events/laptop/0000.jsonl"; dav.files.set(k, dav.files.get(k) + "\n{{{garbage\n");
  const r = await B.sy.sync(); assert.equal(r.ok, true); assert.equal(B.log.count(), 2); assert.equal(B.sy.state.corruptLines, 1);
});

test("a damaged state file from the other machine does not break sync", async () => {
  const dav = makeDav(); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock), B = machine("desktop", dav, clock);
  await A.sy.sync(); dav.files.set("pravaha/state/laptop.json", "not json"); const r = await B.sy.sync(); assert.equal(r.ok, true); assert.deepEqual(r.others, {});
});

test("sync never throws on an unexpected error and says so in plain words", async () => {
  const dav = makeDav({ faults: () => 503 }); const clock = { t: 1 }; const A = machine("laptop", dav, clock);
  const r = await A.sy.sync(); assert.equal(r.ok, false); assert.ok(r.error.plain.length > 20); assert.ok(!/undefined|TypeError/.test(r.error.plain));
});

test("lease can be taken, read and released", async () => {
  const dav = makeDav(); const clock = { t: 1700000000000 }; const A = machine("laptop", dav, clock); await A.sy.ensureDirs();
  await A.sy.takeLease(); assert.equal((await A.sy.readLease()).device, "laptop"); await A.sy.releaseLease(); assert.equal((await A.sy.readLease()).device, null);
});
