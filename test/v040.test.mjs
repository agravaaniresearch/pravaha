// 0.4.0: Firefox Sync carries keys, settings, folder order and look; settings file; name clash; honest status; quiet polls.
import test from "node:test";
import assert from "node:assert/strict";
import { world, settings } from "./helpers.mjs";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { ProfileSync, ITEM_LIMIT, patchFor, partData } from "../extension/src/profilesync.js";
import { exportBundle, importBundle, seal, open } from "../extension/src/bundle.js";
import { computeStatus } from "../extension/src/status.js";

// A stand-in for browser.storage.sync shared by two machines.
const area = () => { const m = new Map(); return { m, get: async (keys) => Object.fromEntries(keys.filter(k => m.has(k)).map(k => [k, JSON.parse(JSON.stringify(m.get(k)))])), set: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, JSON.parse(JSON.stringify(v))); } }; };
const clock = (t = 1_000_000) => { const c = { t, now: () => c.t, tick: (n = 1000) => { c.t += n; } }; return c; };
async function blank(w, device, { keys = true, over = {} } = {}) {
  const storage = new MemoryStorage();
  const s = settings(device, over); if (!keys) { s.miniflux = { url: "", token: "" }; s.webdav = { url: "", user: "", pass: "", root: "pravaha" }; s.raindrop = { token: "" }; }
  await storage.set({ settings: s });
  const e = new Engine({ storage, fetchImpl: w.fetchImpl, onChange: () => {} }); await e.load(); return e;
}

test("a fresh machine pulls keys, settings, order and look from Firefox Sync and never pushes first", async () => {
  const w = await world(); const a = area(); const c = clock();
  const old = await blank(w, "laptop"); await old.saveSettings({ pollMinutes: 7, treeOrder: { x: [3, 1, 2] }, ui: { theme: "oled", at: 5 } });
  const po = new ProfileSync({ engine: old, area: a, now: c.now }); await po.reconcile();
  assert.deepEqual([...a.m.keys()].sort(), ["pv:keys", "pv:order", "pv:settings", "pv:ui"]);
  const fresh = await blank(w, "home", { keys: false }); const pf = new ProfileSync({ engine: fresh, area: a, now: c.now });
  const before = JSON.stringify([...a.m]); const r = await pf.reconcile();
  assert.equal(r.seeded, null, "a machine with no keys seeds nothing");
  assert.equal(JSON.stringify([...a.m]), before, "Firefox Sync is untouched");
  assert.equal(fresh.settings.miniflux.token, "good-key"); assert.equal(fresh.settings.webdav.pass, "p"); assert.equal(fresh.settings.raindrop.token, "rd-token");
  assert.equal(fresh.settings.pollMinutes, 7); assert.deepEqual(fresh.settings.treeOrder, { x: [3, 1, 2] }); assert.equal(fresh.settings.ui.theme, "oled");
  assert.equal(fresh.settings.device, "home", "the machine name never travels");
});
test("the newest write wins per part, and an older remote item is ignored", async () => {
  const w = await world(); const a = area(); const c = clock();
  const x = await blank(w, "x"); const y = await blank(w, "y");
  const px = new ProfileSync({ engine: x, area: a, now: c.now }); const py = new ProfileSync({ engine: y, area: a, now: c.now });
  await px.reconcile(); c.tick(); await py.reconcile();
  c.tick(); await x.saveSettings({ pollMinutes: 11 }); await px.push(["settings"]);
  c.tick(); await y.saveSettings({ pollMinutes: 22 }); await py.push(["settings"]);
  const rx = await px.pull(); assert.equal(x.settings.pollMinutes, 22); assert.ok(rx.applied.some(p => p.part === "settings"));
  const again = await px.pull(); assert.equal(again.applied.length, 0, "nothing new, nothing applied");
  // A stale item written by a machine with a slow clock does not replace newer local data.
  a.m.set("pv:settings", { v: 1, at: 5, by: "old", data: { pollMinutes: 99 } }); await px.pull(); assert.equal(x.settings.pollMinutes, 22);
  await px.pull({ force: true }); assert.equal(x.settings.pollMinutes, 99, "Fetch now takes whatever is there");
});
test("the two toggles stop sending and receiving, and an unconfigured machine never sends keys", async () => {
  const w = await world(); const a = area(); const c = clock();
  const x = await blank(w, "x"); await x.saveSettings({ sync: { keys: false, settings: true } });
  const px = new ProfileSync({ engine: x, area: a, now: c.now }); await px.push();
  assert.ok(!a.m.has("pv:keys") && a.m.has("pv:settings"));
  const e = await blank(w, "e", { keys: false }); const pe = new ProfileSync({ engine: e, area: a, now: c.now }); const r = await pe.push(); assert.ok(!r.sent.includes("keys")); assert.ok(!a.m.has("pv:keys"));
  const before = JSON.stringify([...a.m]); await e.saveSettings({ pollMinutes: 3, ui: { theme: "light" } }); const r2 = await pe.push(null, { force: true }); assert.deepEqual(r2.sent, [], "a machine with no keys writes nothing at all, not even its look"); assert.equal(JSON.stringify([...a.m]), before);
  a.m.set("pv:keys", { v: 1, at: 9e9, by: "z", data: { miniflux: { url: "https://q", token: "t" } } });
  await e.saveSettings({ sync: { keys: false, settings: true } }); await pe.pull(); assert.equal(e.settings.miniflux.token, "", "keys toggle off means keys are not taken");
});
test("an oversized part is kept local with a plain sentence and does not block the others", async () => {
  const w = await world(); const a = area(); const c = clock(); const x = await blank(w, "x");
  await x.saveSettings({ ui: { theme: "light", huge: "x".repeat(ITEM_LIMIT + 10) } });
  const p = new ProfileSync({ engine: x, area: a, now: c.now }); const r = await p.push();
  assert.deepEqual(r.skipped, ["ui"]); assert.ok(r.sent.includes("keys") && r.sent.includes("settings")); assert.match(p.lastError, /too large/);
});
test("malformed remote data is ignored; a write error becomes a plain message", async () => {
  const w = await world(); const a = area(); const x = await blank(w, "x", { keys: false });
  a.m.set("pv:keys", { v: 2, at: 5, data: {} }); a.m.set("pv:settings", "junk"); a.m.set("pv:ui", { v: 1, at: 5, by: "q", data: "str" });
  const p = new ProfileSync({ engine: x, area: a }); const r = await p.pull(); assert.equal(r.applied.length, 0);
  assert.equal(patchFor("keys", null), null); assert.equal(patchFor("nope", {}), null); assert.equal(partData(x.settings, "nope"), null);
  const bad = { get: async () => ({}), set: async () => { throw new Error("QuotaExceededError"); } }; const y = await blank(w, "y");
  const py = new ProfileSync({ engine: y, area: bad }); const rr = await py.push(); assert.match(rr.error, /refused the write/);
  const dead = { get: async () => { throw new Error("no sync"); }, set: async () => {} }; const pd = new ProfileSync({ engine: y, area: dead }); const rd = await pd.pull(); assert.match(rd.error, /could not be read/);
});

test("a settings file round-trips; keys are sealed and need the right passphrase; history merges", async () => {
  const w = await world(); const x = await blank(w, "laptop"); await x.syncNow(); await x.saveSettings({ pollMinutes: 9, treeOrder: { y: [2, 1] } }); await x.train("tag", "navy", 1);
  await assert.rejects(exportBundle(x, { keys: true }), (e) => e.code === "need-passphrase");
  const f = await exportBundle(x, { keys: true, passphrase: "pw", history: true }); const text = JSON.stringify(f);
  assert.ok(!text.includes("good-key") && !text.includes('"p"') && !text.includes("rd-token"), "no key in the clear");
  assert.ok(f.events.length > 0);
  const nokeys = await exportBundle(x, {}); assert.equal(nokeys.keys, null); assert.equal(nokeys.events, undefined);
  const y = await blank(w, "home", { keys: false });
  await assert.rejects(importBundle(y, text), (e) => e.code === "need-passphrase");
  await assert.rejects(importBundle(y, text, { passphrase: "nope" }), (e) => e.code === "bad-passphrase");
  assert.equal(y.settings.miniflux.token, "", "a failed import changes nothing");
  const r = await importBundle(y, text, { passphrase: "pw" });
  assert.ok(r.applied.includes("keys") && r.applied.includes("settings") && r.applied.includes("history")); assert.ok(r.events > 0);
  assert.equal(y.settings.miniflux.token, "good-key"); assert.equal(y.settings.pollMinutes, 9); assert.deepEqual(y.settings.treeOrder, { y: [2, 1] }); assert.equal(y.settings.device, "home");
  const r2 = await importBundle(y, text, { passphrase: "pw" }); assert.equal(r2.events, 0, "importing twice adds no duplicate history");
});
test("a settings file with no keys imports without a passphrase; bad files are refused plainly", async () => {
  const w = await world(); const x = await blank(w, "laptop"); await x.saveSettings({ pollMinutes: 13 }); const f = JSON.stringify(await exportBundle(x, {}));
  const y = await blank(w, "home", { keys: false }); const r = await importBundle(y, f); assert.equal(r.hadKeys, false); assert.equal(y.settings.pollMinutes, 13); assert.equal(y.settings.miniflux.token, "");
  await assert.rejects(importBundle(y, "not json"), (e) => e.code === "bad-file"); await assert.rejects(importBundle(y, '{"format":"other"}'), (e) => e.code === "bad-file");
  await assert.rejects(importBundle(y, JSON.stringify({ format: "pravaha-settings", version: 99 })), (e) => e.code === "newer-file");
  const s = await seal({ a: 1 }, "k", 1000); assert.deepEqual(await open(s, "k"), { a: 1 }); await assert.rejects(open(s, "z"), (e) => e.code === "bad-passphrase");
});

test("status says off, not in sync, when nothing is connected; scope tells what is covered", () => {
  const base = { now: 1e6, device: "d", myHead: 0, remoteHeads: {}, others: {}, miniflux: { configured: false }, webdav: { configured: false }, raindrop: { configured: false }, pendingOps: 0, pendingEvents: 0, corruptLines: 0, feeds: { total: 0 } };
  const none = computeStatus(base); assert.equal(none.overall, "off"); assert.equal(none.scope, "none");
  const mf = computeStatus({ ...base, miniflux: { configured: true, lastOkAt: 1e6 - 1000 } }); assert.equal(mf.overall, "green"); assert.equal(mf.scope, "miniflux");
  const full = computeStatus({ ...base, miniflux: { configured: true, lastOkAt: 1 }, webdav: { configured: true, lastOkAt: 1 } }); assert.equal(full.scope, "full");
  const red = computeStatus({ ...base, miniflux: { configured: true, error: { plain: "Down." } } }); assert.equal(red.overall, "red");
});

test("two installs with the same machine name are stopped before any history is mixed", async () => {
  const w = await world(); const a = await w.mk("laptop"); await a.e.syncNow();
  const b = await w.mk("laptop"); await b.e.syncNow();
  assert.ok(b.e.nameClash, "the second install notices"); assert.equal(b.e.status().nameClash.device, "laptop");
  assert.match(b.e.net.webdav.error.plain, /already using the name/);
  const state = JSON.parse(w.dav.files.get("pravaha/state/laptop.json")); assert.equal(state.installId, a.e.settings.installId, "the first install's state is untouched");
  await a.e.syncNow(); assert.equal(a.e.nameClash, null, "the owner is not disturbed");
});

test("history import reports progress and a quiet poll stays silent when nothing changed", async () => {
  const w = await world(); const a = await w.mk("laptop"); await a.e.syncNow(); await a.e.train("tag", "navy", 1); await a.e.syncNow();
  const seen = []; const storage = new MemoryStorage(); await storage.set({ settings: settings("home") });
  let n = 0; const b = new Engine({ storage, fetchImpl: w.fetchImpl, onChange: () => { n++; } }); await b.load();
  const orig = b._act.bind(b); b._act = (k, l, d, t) => { if (k === "history") seen.push([d, t]); return orig(k, l, d, t); };
  await b.syncNow(); assert.ok(b.imported && b.imported.events > 0, "the arrival is recorded"); assert.ok(seen.length >= 1, "progress was reported");
  n = 0; await b.syncNow({ quiet: true }); assert.equal(n, 0, "an idle background poll announces nothing");
  assert.equal(b.imported.fresh, true, "the first history from a machine is announced");
  await a.e.train("tag", "navy", 2); await a.e.syncNow(); await b.syncNow({ quiet: true }); assert.equal(b.imported.fresh, false, "a later trickle from the same machine is not announced");
  w.mf.st.entries.push({ ...w.mf.st.entries[0], id: 77, title: "Brand new story", status: "unread" }); n = 0;
  await b.syncNow({ quiet: true }); assert.ok(n >= 1, "a visible change is announced");
});

import { readFileSync } from "node:fs";
test("the progress bar cannot widen the page: it clips its own animation and animates only while showing", () => {
  const css = readFileSync(new URL("../extension/ui/reader.css", import.meta.url), "utf8");
  const rule = css.match(/\.progress \{[^}]*\}/)[0]; assert.match(rule, /overflow:\s*hidden/); assert.match(rule, /position:\s*fixed/);
  assert.ok(!/\.progress\[data-mode="indeterminate"\] i \{[^}]*animation/.test(css), "a hidden bar must not keep animating");
  assert.match(css, /\.progress\[data-on="true"\]\[data-mode="indeterminate"\] i \{[^}]*animation: slide/);
});
