// Optional weekly enrichment from outside (for example a Grok automation) through WebDAV files.
// The reader writes enrich/outbox.json and reads enrich/results.json. Scoring stays local.
export function buildOutbox({ items, centroidTerms, now, band = [0.25, 0.45], max = 60 }) {
  const picked = items.filter(i => i.score >= band[0] && i.score <= band[1]).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, max);
  return {
    version: 1, createdAt: now,
    instructions: "For each item, return a score from 0 to 1 for likely value to this reader (social attention, source authority, fit to centroidTerms) and a flag of \"serendipity\" if it is strong but outside the usual topics. Write the answer to results.json in this folder in the shape {\"version\":1,\"results\":[{\"id\":123,\"score\":0.7,\"flag\":\"serendipity\",\"note\":\"why\"}]}.",
    centroidTerms,
    items: picked.map(i => ({ id: i.id, title: i.title, summary: i.summary, url: i.url, feed: i.feedTitle, localScore: i.score }))
  };
}
export function parseResults(text) {
  let j; try { j = JSON.parse(text); } catch { return { map: {}, rejected: 1 }; }
  const map = {}; let rejected = 0;
  for (const r of (j && j.results) || []) {
    if (r && Number.isFinite(Number(r.id)) && typeof r.score === "number" && r.score >= 0 && r.score <= 1)
      map[r.id] = { score: r.score, flag: r.flag === "serendipity" ? "serendipity" : null, note: String(r.note || "").slice(0, 200) };
    else rejected += 1;
  }
  return { map, rejected };
}
