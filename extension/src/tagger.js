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

export function suggestTags(itemVec, itemStems, profiles, max = 4) {
  const stems = new Set(itemStems);
  const scored = [];
  for (const [tag, p] of Object.entries(profiles)) {
    let s = cosine(itemVec, p.vec) * (1 + Math.log10(1 + p.count) * 0.25);
    if (p.stems.length && p.stems.every(x => stems.has(x))) s += 0.25; // the tag's own words appear in the article
    if (s > 0.12) scored.push({ tag, score: Math.round(s * 1000) / 1000 });
  }
  return scored.sort((a, b) => b.score - a.score || (a.tag < b.tag ? -1 : 1)).slice(0, max);
}
