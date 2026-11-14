// Failure-injection harness. Runs two machines against fake servers whose requests fail at random,
// then lets the network recover and checks that nothing was lost and both machines agree.
// Usage: node tools/failure-rates.mjs [trials] [--write]   (seeded, so the numbers repeat exactly)
import { writeFileSync } from "node:fs";
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
const head = "| Request failure rate | Converged | Same state on both | Trials with a lost read | Stars correct | Lights all green | Trials with an unhandled error | Avg recovery passes | Worst |\n|---|---|---|---|---|---|---|---|---|";
const table = head + "\n" + rows.map(x => `| ${Math.round(x.p * 100)}% | ${x.converged} | ${x.stateEqual} | ${x.lost} | ${x.stars} | ${x.green} | ${x.crash} | ${x.avg} | ${x.worst} |`).join("\n");
console.log(table);
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `# Failure rates\n\nGenerated by \`node tools/failure-rates.mjs ${TRIALS} --write\`. Seeded, so a re-run gives the same numbers.\n\nEach trial runs two machines for 40 random actions (sync, mark read, open, dismiss, save, train, dwell) against fake Miniflux, WebDAV and Raindrop servers. During the actions, each request fails at the stated rate (60% as a dropped connection, 40% as a server error). Then the network recovers and both machines sync up to six passes. ${TRIALS} trials per row.\n\n${table}\n\n## How to read this\n\n- **Converged** means both machines hold the same events and nothing is waiting to be sent.\n- **Lost read** means an article the reader marked read never reached Miniflux after recovery.\n- **Unhandled error** means an action threw instead of queueing. It should be zero at every rate.\n- This measures the reader's own queueing and merging logic. It does not measure real Miniflux, Fastmail or Raindrop behaviour, which these fakes only imitate.\n`);
}
