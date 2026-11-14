// Failure-injection harness. Runs two machines against fake servers whose requests fail at random,
// then lets the network recover and checks that nothing was lost and both machines agree.
// Usage: node tools/failure-rates.mjs [trials] [--write]   (seeded, so the numbers repeat exactly)
import { writeFileSync, appendFileSync } from "node:fs";
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeDav, makeMiniflux, makeRaindrop, router, feed, entry, settings } from "../test/helpers.mjs";

const TRIALS = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 150;
const RATES = [0, 0.05, 0.2, 0.5];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function trial(seed, p) {
  const r = rng(seed); const ctl = { p };
  const chaos = () => { if (ctl.p === 0) return null; const x = r(); return x < ctl.p * 0.6 ? "throw" : x < ctl.p ? 500 : null; };
  const dav = makeDav({ faults: chaos }), mf = makeMiniflux({ faults: chaos }), rd = makeRaindrop({ faults: chaos, bookmarks: [] });
  mf.st.feeds = [feed(1, "A", "X/Y"), feed(2, "B", "Z")];
  for (let i = 1; i <= 40; i++) { const e = entry(i, 1 + (i % 2), `Story ${i} about ships and ports`, "content body " + i, i); e.feed = { id: e.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(e); }
  const fetchImpl = router({ dav, mf, rd });
  const mk = async (name) => { const s = new MemoryStorage(); await s.set({ settings: settings(name, { raindrop: { token: "" } }) }); const e = new Engine({ storage: s, fetchImpl }); await e.load(); return e; };
  const M = [await mk("laptop"), await mk("desktop")]; const readIds = new Set(); const mine = [new Set(), new Set()]; let crashes = 0;
  ctl.p = 0; await M[0].syncNow(); await M[1].syncNow(); ctl.p = p;
  for (let step = 0; step < 40; step++) {
    const k = Math.floor(r() * 2), m = M[k]; const id = 1 + Math.floor(r() * 40); const op = Math.floor(r() * 7);
    try {
      if (op === 0) await m.syncNow();
      else if (op === 1) { await m.markRead([id]); readIds.add(id); }
      else if (op === 2) { await m.open(id); readIds.add(id); }
      else if (op === 3) { await m.dismiss(id); readIds.add(id); }
      else if (op === 4) { const sid = (id % 2 === k ? id : (id % 40) + 1); if (sid % 2 === k) { await m.toggleSave(sid); mine[k].has(sid) ? mine[k].delete(sid) : mine[k].add(sid); } }
      else if (op === 5) await m.train("feed", 1 + Math.floor(r() * 2), [1, -1, 0][Math.floor(r() * 3)]);
      else await m.recordDwell(id, 1 + (id % 2), 20000);
    } catch { crashes++; }
  }
  ctl.p = 0; let passes = 0;
  const same = () => JSON.stringify(M[0].log.list().map(e => e.eid)) === JSON.stringify(M[1].log.list().map(e => e.eid)) && M.every(m => m.syncer.pending().length === 0 && m.pendingOps.length === 0);
  for (; passes < 6 && !(passes >= 2 && same()); passes++) { await M[0].syncNow(); await M[1].syncNow(); }
  const converged = same();
  const dism = (m) => JSON.stringify([...m._derive().dismissed].sort()), trn = (m) => JSON.stringify(m._derive().training.map(t => `${t.type}:${t.key}:${t.value}`).sort());
  const stateEqual = dism(M[0]) === dism(M[1]) && trn(M[0]) === trn(M[1]);
  const lostReads = [...readIds].filter(id => mf.st.entries.find(e => e.id === id).status !== "read").length;
  const starsOk = [0, 1].every(k => [...mine[k]].every(id => mf.st.entries.find(e => e.id === id).starred) && mf.st.entries.filter(e => e.starred && e.id % 2 === k).length === mine[k].size);
  const allGreen = M.every(m => m.status().overall === "green");
  return { converged, stateEqual, lostReads, starsOk, allGreen, crashes, passes };
}

const rows = [];
for (const p of RATES) {
  let c = 0, s = 0, lost = 0, stars = 0, green = 0, crash = 0, passes = 0, worst = 0;
  for (let i = 0; i < TRIALS; i++) { const t = await trial(1000 + i * 17 + Math.round(p * 100), p); c += t.converged; s += t.stateEqual; lost += t.lostReads > 0; stars += t.starsOk; green += t.allGreen; crash += t.crashes > 0; passes += t.passes; worst = Math.max(worst, t.passes); }
  const pc = (n) => (100 * n / TRIALS).toFixed(1) + "%";
  rows.push({ p, converged: pc(c), stateEqual: pc(s), lost: pc(lost), stars: pc(stars), green: pc(green), crash: pc(crash), avg: (passes / TRIALS).toFixed(2), worst });
}

// ---------- bulk mark-read (0.3.0) ----------
// One reader marks 240 articles read in one action while requests fail at the stated rate, and Miniflux silently ignores
// about 8% of the ids it is sent (the failure behind "some of the unread articles remain"). Compared: with and without the check.
async function bulkTrial(seed, p, verify, forget) {
  const r = rng(seed); const ctl = { p: 0 };
  const chaos = () => { if (ctl.p === 0) return null; const x = r(); return x < ctl.p * 0.6 ? "throw" : x < ctl.p ? 500 : null; };
  const dav = makeDav(), mf = makeMiniflux({ faults: chaos }), rd = makeRaindrop({ bookmarks: [] });
  mf.st.feeds = [feed(1, "A", "X/Y"), feed(2, "B", "Z"), feed(3, "C", "Z")];
  for (let i = 1; i <= 240; i++) { const e = entry(i, 1 + (i % 3), `Story ${i}`, "body " + i, i / 10); e.feed = { id: e.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(e); }
  const base = mf.handler; mf.handler = async (url, opts = {}) => {
    if (opts.method === "PUT" && new URL(url).pathname.endsWith("/v1/entries") && opts.body) { const b = JSON.parse(opts.body); b.entry_ids = b.entry_ids.filter(() => r() > 0.08); opts = { ...opts, body: JSON.stringify(b) }; }
    return base(url, opts);
  };
  const fetchImpl = router({ dav, mf, rd }); const st = new MemoryStorage(); await st.set({ settings: settings("laptop", { raindrop: { token: "" } }) });
  const e = new Engine({ storage: st, fetchImpl }); await e.load(); await e.syncNow(); ctl.p = p;
  let crashed = false, res = null; const ids = Object.values(e.cache.items).filter(i => i.status === "unread").map(i => i.id);
  try { res = await e.markRead(ids, { verify }); } catch { crashed = true; }
  if (forget) e.cache.recent = {}; // the 0.2.3 behaviour: whatever Miniflux says afterwards wins, with no second try
  ctl.p = 0; for (let i = 0; i < 6; i++) await e.syncNow();
  const left = mf.st.entries.filter(x => x.status === "unread").length;
  return { left, crashed, claimedOk: !!(res && res.verified && left > 0), maxReq: 0 };
}
const VARIANTS = [["a", "0.2.3 behaviour: no check, no second try", false, true], ["b", "Second try on the next refresh only", false, false], ["c", "0.3.0: check afterwards and second try", true, false]];
const bulkRows = []; const NB = Math.min(TRIALS, 100);
for (const p of RATES) {
  const row = { p }; for (const [key, , verify, forget] of VARIANTS) {
    let any = 0, leftSum = 0, crash = 0, lie = 0;
    for (let i = 0; i < NB; i++) { const t = await bulkTrial(5000 + i * 31 + Math.round(p * 100), p, verify, forget); any += t.left > 0; leftSum += t.left; crash += t.crashed; lie += t.claimedOk; }
    row[key] = { any: (100 * any / NB).toFixed(1) + "%", avg: (leftSum / NB).toFixed(1), crash: (100 * crash / NB).toFixed(1) + "%", lie: (100 * lie / NB).toFixed(1) + "%" };
  }
  bulkRows.push(row);
}
const bulkTable = "| Request failure rate | 0.2.3 behaviour: trials with articles left unread | Avg left | Second try only: trials | Avg left | 0.3.0: trials | Avg left | 0.3.0 unhandled errors | 0.3.0 said \"confirmed\" while some were unread |\n|---|---|---|---|---|---|---|---|---|\n" +
  bulkRows.map(x => `| ${Math.round(x.p * 100)}% | ${x.a.any} | ${x.a.avg} | ${x.b.any} | ${x.b.avg} | ${x.c.any} | ${x.c.avg} | ${x.c.crash} | ${x.c.lie} |`).join("\n");
console.log("\n" + bulkTable);
const head = "| Request failure rate | Converged | Same state on both | Trials with a lost read | Stars correct | Lights all green | Trials with an unhandled error | Avg recovery passes | Worst |\n|---|---|---|---|---|---|---|---|---|";
const table = head + "\n" + rows.map(x => `| ${Math.round(x.p * 100)}% | ${x.converged} | ${x.stateEqual} | ${x.lost} | ${x.stars} | ${x.green} | ${x.crash} | ${x.avg} | ${x.worst} |`).join("\n");
console.log(table);
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `# Failure rates\n\nGenerated by \`node tools/failure-rates.mjs ${TRIALS} --write\`. Seeded, so a re-run gives the same numbers.\n\nEach trial runs two machines for 40 random actions (sync, mark read, open, dismiss, save, train, dwell) against fake Miniflux, WebDAV and Raindrop servers. During the actions, each request fails at the stated rate (60% as a dropped connection, 40% as a server error). Then the network recovers and both machines sync up to six passes. ${TRIALS} trials per row.\n\n${table}\n\n## How to read this\n\n- **Converged** means both machines hold the same events and nothing is waiting to be sent.\n- **Lost read** means an article the reader marked read never reached Miniflux after recovery.\n- **Unhandled error** means an action threw instead of queueing. It should be zero at every rate.\n- This measures the reader's own queueing and merging logic. It does not measure real Miniflux, Fastmail or Raindrop behaviour, which these fakes only imitate.\n`);
  appendFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `\n## Marking many articles read (0.3.0)\n\nOne reader marks 240 articles read in one action while requests fail at the stated rate, and the fake Miniflux silently ignores about 8% of the ids it is sent, which is the failure behind "some of the unread articles remain". After the network recovers there are six sync passes, then the count of articles still unread on Miniflux is taken. The first variant imitates 0.2.3: whatever Miniflux reports afterwards wins and nothing is sent again. The second only sends again on the next refresh. The third is 0.3.0: it asks Miniflux straight after the bulk mark, sends again what did not stick, and also sends again on later refreshes. ${Math.min(TRIALS, 100)} trials per row.\n\n${bulkTable}\n\n- A trial with leftovers means that after recovery some article the reader had marked read was still unread on Miniflux.\n- "Said confirmed while some were unread" must be zero: the reader never reports a confirmation it did not get.\n- The fake imitates one failure mode. Real Miniflux may fail in other ways, which is why the reader asks Miniflux afterwards instead of trusting its own request.\n`);
}
