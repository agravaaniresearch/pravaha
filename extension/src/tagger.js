// Local tag suggestion. Matches an article against the tag vocabulary you already use in Raindrop.
// No model, no network: same article and same vocabulary always give the same tags.
import { tokenize, stem } from "./text.js";
import { cosine, mean } from "./vector.js";

export function buildTagProfiles(bookmarks, corpus) {
  const byTag = new Map();
  for (const b of bookmarks) {
    const v = corpus.vector(tokenize(`${b.title} ${b.excerpt} ${b.note}`));
    for (const t of b.tags) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(v); }
  }
  const profiles = {};
  for (const [tag, vecs] of byTag) profiles[tag] = { count: vecs.length, vec: mean(vecs), stems: tokenize(tag.replace(/[-_]/g, " ")) };
  return profiles;
}

// Scoring every article against every tag one pair at a time was slow on a big library (seconds for a few thousand articles), so the tag profiles are
// turned once into an index from each word to the tags that contain it. An article then touches only the tags it shares a word with. Same arithmetic, same answers.
const INDEX = new WeakMap();
function indexOf(profiles) {
  let ix = INDEX.get(profiles); if (ix) return ix;
  const names = Object.keys(profiles).sort(); const post = new Map();
  names.forEach((tag, i) => { for (const k in profiles[tag].vec) { const w = profiles[tag].vec[k]; if (!w) continue; let l = post.get(k); if (!l) post.set(k, l = []); l.push(i, w); } });
  ix = { names, post, boost: names.map(t => 1 + Math.log10(1 + profiles[t].count) * 0.25) }; INDEX.set(profiles, ix); return ix;
}
export function suggestTags(itemVec, itemStems, profiles, max = 4) {
  const stems = new Set(itemStems); const ix = indexOf(profiles); const dot = new Float64Array(ix.names.length); const touched = new Set();
  for (const k in itemVec) { const w = itemVec[k]; const l = w && ix.post.get(k); if (l) for (let j = 0; j < l.length; j += 2) { dot[l[j]] += w * l[j + 1]; touched.add(l[j]); } }
  for (let i = 0; i < ix.names.length; i++) { const st = profiles[ix.names[i]].stems; if (st.length && st.every(x => stems.has(x))) touched.add(i); }
  const scored = [];
  for (const i of touched) {
    const p = profiles[ix.names[i]]; let sc = dot[i] * ix.boost[i];
    if (p.stems.length && p.stems.every(x => stems.has(x))) sc += 0.25; // the tag's own words appear in the article
    if (sc > 0.12) scored.push({ tag: ix.names[i], score: Math.round(sc * 1000) / 1000 });
  }
  return scored.sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1)).slice(0, max);
}
