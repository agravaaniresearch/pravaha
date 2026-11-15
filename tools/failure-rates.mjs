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

// ---------- light refresh and feed management (0.6.0) ----------
// A: one reader holds 200 unread articles. Meanwhile 15 arrive, and 10 are read in another app. The refresh runs while requests fail at the stated rate,
//    then the network recovers. "Diverged" means the reader's unread list still differs from Miniflux afterwards. "drift" makes Miniflux answer the
//    entry-number call in a shape Pravaha does not know (what a silent server update could do); the reader must fall back and still be right.
async function lightTrial(seed, p, drift) {
  const r = rng(seed); const ctl = { p: 0 };
  const chaos = () => { if (ctl.p === 0) return null; const x = r(); return x < ctl.p * 0.6 ? "throw" : x < ctl.p ? 500 : null; };
  const dav = makeDav(), mf = makeMiniflux({ faults: chaos }), rd = makeRaindrop({ bookmarks: [] });
  mf.st.feeds = [feed(1, "A", "X/Y"), feed(2, "B", "Z"), feed(3, "C", "Z")];
  for (let i = 1; i <= 200; i++) { const e = entry(i, 1 + (i % 3), `Story ${i}`, "body " + i, i / 10); e.feed = { id: e.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(e); }
  const fetchImpl = router({ dav, mf, rd }); const st = new MemoryStorage(); await st.set({ settings: settings("laptop", { raindrop: { token: "" } }) });
  const e = new Engine({ storage: st, fetchImpl }); await e.load(); await e.syncNow();
  for (let i = 201; i <= 215; i++) { const x = entry(i, 1 + (i % 3), `Story ${i}`, "body " + i, 0.1); x.feed = { id: x.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(x); }
  for (let i = 1; i <= 10; i++) mf.st.entries.find(x => x.id === i * 7).status = "read";
  if (drift) mf.st.badIds = true; ctl.p = p; let crashed = false;
  try { await e.syncNow(); } catch { crashed = true; }
  ctl.p = 0; let mode = null; for (let i = 0; i < 4; i++) { try { await e.syncNow(); } catch { crashed = true; } mode = e.net.miniflux && e.net.miniflux.mode; }
  const mine = new Set(Object.values(e.cache.items).filter(x => x.status === "unread").map(x => x.id)); const theirs = new Set(mf.st.entries.filter(x => x.status === "unread").map(x => x.id));
  const same = mine.size === theirs.size && [...mine].every(id => theirs.has(id));
  return { diverged: !same, crashed, mode, red: (e.status().lights.find(l => l.id === "server") || {}).state === "red" };
}
const lightRows = []; const NL = Math.min(TRIALS, 100);
for (const [label, drift, ps] of [["Normal server", false, RATES], ["Unknown answer shape", true, [0]]]) for (const p of ps) {
  let div = 0, crash = 0, light = 0, red = 0;
  for (let i = 0; i < NL; i++) { const t = await lightTrial(7000 + i * 17 + Math.round(p * 100) + (drift ? 3 : 0), p, drift); div += t.diverged; crash += t.crashed; light += t.mode === "light"; red += t.red; }
  lightRows.push({ label, p, div: (100 * div / NL).toFixed(1) + "%", crash: (100 * crash / NL).toFixed(1) + "%", light: (100 * light / NL).toFixed(1) + "%", red: (100 * red / NL).toFixed(1) + "%" });
}
const lightTable = "| Case | Request failure rate | Reader differs from Miniflux after recovery | Unhandled errors | Last refresh was the light kind | Server light red |\n|---|---|---|---|---|---|\n" +
  lightRows.map(x => `| ${x.label} | ${Math.round(x.p * 100)}% | ${x.div} | ${x.crash} | ${x.light} | ${x.red} |`).join("\n");
console.log("\n" + lightTable);

// B: rename a folder that holds two subfolders (three Miniflux categories, renamed one call at a time) while requests fail at the stated rate.
//    Complete means all three were renamed. Reported partial means some were not and the reader said so. "Wrong claim" means the reader said it succeeded while Miniflux disagrees.
//    "View differs" means that after recovery the reader's folders do not match Miniflux's.
async function renameTrial(seed, p) {
  const r = rng(seed); const ctl = { p: 0 };
  const chaos = () => { if (ctl.p === 0) return null; const x = r(); return x < ctl.p * 0.6 ? "throw" : x < ctl.p ? 500 : null; };
  const dav = makeDav(), mf = makeMiniflux({ faults: chaos }), rd = makeRaindrop({ bookmarks: [] });
  mf.st.feeds = [feed(1, "A", "Top"), feed(2, "B", "Top/Sub1"), feed(3, "C", "Top/Sub2"), feed(4, "D", "Other")];
  for (let i = 1; i <= 8; i++) { const e = entry(i, 1 + (i % 4), `Story ${i}`, "body " + i, i); e.feed = { id: e.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(e); }
  const fetchImpl = router({ dav, mf, rd }); const st = new MemoryStorage(); await st.set({ settings: settings("laptop", { raindrop: { token: "" } }) });
  const e = new Engine({ storage: st, fetchImpl }); await e.load(); await e.syncNow(); ctl.p = p; let res = null, crashed = false;
  try { res = await e.folderRename("Top", "Main"); } catch { crashed = true; }
  ctl.p = 0; for (let i = 0; i < 3; i++) { try { await e.syncNow(); } catch { crashed = true; } }
  const server = mf.st.feeds.map(f => f.category.title).sort().join("|"); const mine = e.cache.feeds.map(f => f.category).sort().join("|");
  const done = server === ["Main", "Main/Sub1", "Main/Sub2", "Other"].sort().join("|");
  return { complete: done, partialReported: !done && !!res && !res.ok && /already renamed|Nothing was renamed|already exists/.test(res.sentence), wrong: !!(res && res.ok && !done), differs: server !== mine, crashed };
}
const renRows = []; const NR = Math.min(TRIALS, 100);
for (const p of RATES) {
  let c = 0, pr = 0, w = 0, d = 0, cr = 0;
  for (let i = 0; i < NR; i++) { const t = await renameTrial(9000 + i * 13 + Math.round(p * 100), p); c += t.complete; pr += t.partialReported; w += t.wrong; d += t.differs; cr += t.crashed; }
  const f = (n) => (100 * n / NR).toFixed(1) + "%"; renRows.push({ p, c: f(c), pr: f(pr), unexplained: f(NR - c - pr > 0 ? (NR * 0 + (NR - c - pr)) : 0), w: f(w), d: f(d), cr: f(cr) });
}
const renTable = "| Request failure rate | All three renamed | Partly renamed and the reader said so | Not renamed, no explanation | Said it succeeded while Miniflux disagrees | View differs from Miniflux after recovery | Unhandled errors |\n|---|---|---|---|---|---|---|\n" +
  renRows.map(x => `| ${Math.round(x.p * 100)}% | ${x.c} | ${x.pr} | ${x.unexplained} | ${x.w} | ${x.d} | ${x.cr} |`).join("\n");
console.log("\n" + renTable);

// ---------- training: thumbs and tag clicks (0.7.0) ----------
async function trainTrial(seed, p) {
  const r = rng(seed); const ctl = { p: 0 };
  const chaos = () => { if (ctl.p === 0) return null; const x = r(); return x < ctl.p * 0.6 ? "throw" : x < ctl.p ? 500 : null; };
  const dav = makeDav({ faults: chaos }), mf = makeMiniflux({ faults: chaos });
  const topics = ["navy ship port", "tax budget bank", "recipe cake oven", "cricket match score"];
  const rd = makeRaindrop({ faults: chaos, bookmarks: Array.from({ length: 16 }, (_, i) => ({ _id: i, title: `${topics[i % 4]} note ${i}`, excerpt: topics[i % 4], note: "", tags: [["defence", "economy", "food", "sport"][i % 4], "watch"], link: `https://saved.example/${i}`, lastUpdate: new Date().toISOString() })) });
  mf.st.feeds = [feed(1, "A", "X/Y"), feed(2, "B", "Z")];
  for (let i = 1; i <= 24; i++) { const e = entry(i, 1 + (i % 2), `Story ${i} about ${topics[i % 4]}`, `${topics[i % 4]} details ${i}`, i); e.feed = { id: e.feed_id, title: "F", category: { title: "X" } }; mf.st.entries.push(e); }
  const fetchImpl = router({ dav, mf, rd });
  const mk = async (name) => { const s = new MemoryStorage(); await s.set({ settings: settings(name, { raindrop: { token: "rd-token" } }) }); const e = new Engine({ storage: s, fetchImpl }); await e.load(); return e; };
  const M = [await mk("laptop"), await mk("desktop")]; let crashes = 0; const quiet = () => { for (const m of M) { for (const t of m._timers) clearTimeout(t); m._timers.clear(); } };
  await M[0].syncNow(); await M[1].syncNow(); quiet();
  const base = Array.from({ length: 24 }, (_, i) => M[0].scoreRow(i + 1).score); const rated = new Set(), tagged = new Set();
  ctl.p = p;
  for (let step = 0; step < 30; step++) {
    const m = M[Math.floor(r() * 2)]; const id = 1 + Math.floor(r() * 24); const op = Math.floor(r() * 5);
    try {
      if (op === 0) await m.syncNow(); else if (op <= 2) { await m.rateStory(id, [1, -1, 0][Math.floor(r() * 3)]); rated.add(id); }
      else { const t = ["defence", "economy", "food", "sport", "watch"][Math.floor(r() * 5)]; await m.train("tag", t, [1, -1, 0][Math.floor(r() * 3)]); tagged.add(t); }
    } catch { crashes++; }
    quiet();
  }
  ctl.p = 0; for (let i = 0; i < 3; i++) for (const m of M) { try { await m.syncNow(); } catch { crashes++; } } quiet();
  const key = (m) => m.trainingRules().map(x => `${x.type}:${x.key}:${x.value}`).sort().join("|"); const stories = (m) => Object.keys(m._derive().story).sort().map(k => `${k}:${m._derive().story[k].value}`).join("|");
  const converged = key(M[0]) === key(M[1]) && stories(M[0]) === stories(M[1]);
  const sameScores = Array.from({ length: 24 }, (_, i) => M[0].scoreRow(i + 1).score === M[1].scoreRow(i + 1).score).every(Boolean);
  for (const id of rated) await M[0].rateStory(id, 0); for (const t of tagged) await M[0].train("tag", t, 0);
  for (let i = 0; i < 3; i++) for (const m of M) await m.syncNow(); quiet();
  // After every thumb and tag is cleared, no rule should remain and every score should be what it was before any training.
  const clean = M[0].trainingRules().length === 0 && Object.keys(M[0]._derive().story).length === 0 && M[1].trainingRules().length === 0;
  const back = Array.from({ length: 24 }, (_, i) => M[0].scoreRow(i + 1).score === base[i]).every(Boolean);
  return { converged, sameScores, clean, back, crashes };
}
const trRows = []; const NT = Math.min(TRIALS, 60);
for (const p of RATES) {
  let c = 0, s2 = 0, cl = 0, bk = 0, cr = 0;
  for (let i = 0; i < NT; i++) { const t = await trainTrial(17000 + i * 31 + Math.round(p * 100), p); c += t.converged; s2 += t.sameScores; cl += t.clean; bk += t.back; cr += t.crashes > 0; }
  const f = (n) => (100 * n / NT).toFixed(1) + "%"; trRows.push({ p, c: f(c), s: f(s2), cl: f(cl), bk: f(bk), cr: f(cr) });
}
const trTable = "| Request failure rate | Both machines hold the same training | Both rank every article the same | No rule left after clearing | Scores exactly as before any training | Trials with an unhandled error |\n|---|---|---|---|---|---|\n" + trRows.map(x => `| ${Math.round(x.p * 100)}% | ${x.c} | ${x.s} | ${x.cl} | ${x.bk} | ${x.cr} |`).join("\n");
console.log("\n" + trTable);
const head = "| Request failure rate | Converged | Same state on both | Trials with a lost read | Stars correct | Lights all green | Trials with an unhandled error | Avg recovery passes | Worst |\n|---|---|---|---|---|---|---|---|---|";
const table = head + "\n" + rows.map(x => `| ${Math.round(x.p * 100)}% | ${x.converged} | ${x.stateEqual} | ${x.lost} | ${x.stars} | ${x.green} | ${x.crash} | ${x.avg} | ${x.worst} |`).join("\n");
console.log(table);
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `# Failure rates\n\nGenerated by \`node tools/failure-rates.mjs ${TRIALS} --write\`. Seeded, so a re-run gives the same numbers.\n\nEach trial runs two machines for 40 random actions (sync, mark read, open, dismiss, save, train, dwell) against fake Miniflux, WebDAV and Raindrop servers. During the actions, each request fails at the stated rate (60% as a dropped connection, 40% as a server error). Then the network recovers and both machines sync up to six passes. ${TRIALS} trials per row.\n\n${table}\n\n## How to read this\n\n- **Converged** means both machines hold the same events and nothing is waiting to be sent.\n- **Lost read** means an article the reader marked read never reached Miniflux after recovery.\n- **Unhandled error** means an action threw instead of queueing. It should be zero at every rate.\n- This measures the reader's own queueing and merging logic. It does not measure real Miniflux, Fastmail or Raindrop behaviour, which these fakes only imitate.\n`);
  appendFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `\n## Marking many articles read (0.3.0)\n\nOne reader marks 240 articles read in one action while requests fail at the stated rate, and the fake Miniflux silently ignores about 8% of the ids it is sent, which is the failure behind "some of the unread articles remain". After the network recovers there are six sync passes, then the count of articles still unread on Miniflux is taken. The first variant imitates 0.2.3: whatever Miniflux reports afterwards wins and nothing is sent again. The second only sends again on the next refresh. The third is 0.3.0: it asks Miniflux straight after the bulk mark, sends again what did not stick, and also sends again on later refreshes. ${Math.min(TRIALS, 100)} trials per row.\n\n${bulkTable}\n\n- A trial with leftovers means that after recovery some article the reader had marked read was still unread on Miniflux.\n- "Said confirmed while some were unread" must be zero: the reader never reports a confirmation it did not get.\n- The fake imitates one failure mode. Real Miniflux may fail in other ways, which is why the reader asks Miniflux afterwards instead of trusting its own request.\n`);
  appendFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `\n## Light refresh and feed management (0.6.0)\n\n**Light refresh.** One reader holds 200 unread articles. While it refreshes, 15 more arrive and 10 are read in another app, and requests fail at the stated rate. After the network recovers the reader's unread list must equal Miniflux's. The second block makes Miniflux answer the entry-number call in a shape Pravaha does not know, as a silent server update could; the reader must fall back to the full download, stay correct, and not turn the server light red for a harmless change.\n\n${lightTable}\n\n**Renaming a folder.** A folder with two subfolders is three Miniflux categories, renamed one call at a time, so a failure part-way leaves some renamed. "Not renamed, no explanation" and "said it succeeded while Miniflux disagrees" must both be zero.\n\n${renTable}\n\n- ${NL} trials per light-refresh row and ${NR} per rename row, seeded.\n- The fakes imitate the documented Miniflux behaviour. They do not prove that the live server behaves the same way; the Check server button on the Sync page is how that is found out.\n`);
  appendFileSync(new URL("../docs/FAILURE_RATES.md", import.meta.url), `\n## Thumbs and tag training (0.7.0)\n\nTwo readers rate articles and click tags at random for 30 steps, on 24 articles with 16 saved pages in Raindrop, while every request (Miniflux, WebDAV and Raindrop) fails at the stated rate. The network then recovers, both sync, and the numbers are read. After that the first reader takes back every thumb and tag it touched, they sync again, and the scores are compared with what they were before any training. ${NT} trials per row.\n\n${trTable}\n\nWhat the columns mean: the training is shared through the history log, so it can only differ between machines while a sync is still pending; once the network recovers both must agree. A thumb remembers exactly which rules it set, so clearing everything must leave no rule behind and every score must return to its starting value; a row below 100% in the last two columns would mean a thumb left residue.\n`);
}
