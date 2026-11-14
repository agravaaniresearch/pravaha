// Local search: fuzzy full text over a compact index of every article seen, plus tag and feed filters.
// Pure functions, no browser APIs. The index keeps read articles long after the reading copy has expired,
// so an article read months ago can still be found.
import { tokenize, stem } from "./text.js";

export const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);

// The most frequent meaningful words of the full article, so a search can find an article by what it says and not only by its title.
export function keywords(html, n = 14) {
  const c = new Map(); for (const t of tokenize(html)) c.set(t, (c.get(t) || 0) + 1);
  return [...c.entries()].filter(([, k]) => k > 1 || c.size < 20).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t).join(" ");
}

export function indexEntry(it, html) {
  return { id: it.id, fi: it.feedId, f: it.feedTitle, t: it.title, g: it.tags || [], k: html ? keywords(html) : "", s: (it.summary || "").slice(0, 200), p: it.publishedAt || 0, u: it.url || "", c: it.category || "" };
}

// Edit distance with early exit; true when within max.
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev[j - 2] + 1); // transposition (approximate)
      cur.push(v); if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false; prev = cur;
  }
  return prev[b.length] <= max;
}

const cache = new WeakMap();
function fieldsOf(e) {
  let f = cache.get(e); if (f) return f;
  const mk = (text, w) => { const raw = words(text); const set = new Set(raw); for (const r of raw) set.add(stem(r)); return { w, list: [...set], set }; };
  f = { title: mk(e.t, 3), tags: mk((e.g || []).join(" "), 2.5), feed: mk(e.f, 1.5), body: mk(`${e.s} ${e.k}`, 1), all: fold(`${e.t} ${e.s} ${e.k} ${e.f}`) };
  cache.set(e, f); return f;
}
function termScore(term, fld) {
  if (fld.set.has(term)) return 1; const st = stem(term); if (st !== term && fld.set.has(st)) return 0.9;
  if (term.length >= 3) for (const t of fld.list) if (t.startsWith(term)) return 0.8;
  if (term.length >= 4) { const max = term.length >= 8 ? 2 : 1; for (const t of fld.list) if (t.length >= 4 && within(term, t, max)) return 0.55; }
  return 0;
}
function bestField(term, f) {
  let best = 0; for (const k of ["title", "tags", "feed", "body"]) { const s = termScore(term, f[k]) * f[k].w; if (s > best) best = s; } return best;
}

// Query language: plain words (all must match, fuzzy), "exact phrase", -excluded, #tag, feed:name, in:read|unread|saved|all, since:30d.
export function parseQuery(q) {
  const out = { terms: [], phrases: [], not: [], tags: [], feed: [], inState: null, since: null };
  const re = /(-?)("([^"]+)"|\S+)/g; let m;
  while ((m = re.exec(String(q || "")))) {
    const neg = m[1] === "-"; let tok = m[3] !== undefined ? m[3] : m[2]; const quoted = m[3] !== undefined;
    if (!quoted && /^#/.test(tok)) { const t = fold(tok.slice(1)); if (t) out.tags.push(t); continue; }
    if (!quoted && /^feed:/i.test(tok)) { const t = fold(tok.slice(5).replace(/^"|"$/g, "")); if (t) out.feed.push(t); continue; }
    if (!quoted && /^in:/i.test(tok)) { const v = tok.slice(3).toLowerCase(); if (["read", "unread", "saved", "all"].includes(v)) out.inState = v; continue; }
    if (!quoted && /^since:\d+d$/i.test(tok)) { out.since = Number(tok.slice(6, -1)); continue; }
    if (quoted) { const p = fold(tok).trim(); if (p) (neg ? out.not : out.phrases).push(p); continue; }
    for (const w of words(tok)) (neg ? out.not : out.terms).push(w);
  }
  return out;
}

export function runSearch(entries, query, { now = Date.now(), limit = 200, stateOf = () => null } = {}) {
  const q = typeof query === "string" ? parseQuery(query) : query; const res = [];
  const needAny = q.terms.length + q.phrases.length + q.tags.length + q.feed.length > 0; if (!needAny) return res;
  for (const e of entries) {
    if (q.since && now - e.p > q.since * 86400000) continue;
    if (q.inState) { const st = stateOf(e); if (q.inState === "saved" ? !(st && st.saved) : q.inState === "all" ? false : (q.inState === "read") !== !!(st ? st.read : true)) continue; }
    const f = fieldsOf(e);
    if (q.feed.length && !q.feed.every(x => f.feed.list.some(w => w.startsWith(x) || within(x, w, 1)) || fold(e.f).includes(x))) continue;
    if (q.tags.length && !q.tags.every(x => f.tags.list.some(w => w.startsWith(x) || (x.length >= 4 && within(x, w, 1))))) continue;
    if (q.phrases.length && !q.phrases.every(p => f.all.includes(p))) continue;
    if (q.not.some(w => bestField(w, f) >= 0.8)) continue;
    let score = 0, miss = 0;
    for (const t of q.terms) { const s = bestField(t, f); if (!s) miss++; else score += s; }
    if (q.terms.length) { const allowed = q.terms.length >= 3 ? 1 : 0; if (miss > allowed || miss === q.terms.length) continue; if (miss) score *= 0.6; }
    score += q.tags.length * 2 + q.feed.length + q.phrases.length * 2;
    const ageDays = Math.max(0, (now - e.p) / 86400000); score += 0.5 / (1 + ageDays / 30);
    res.push({ e, score });
  }
  res.sort((a, b) => b.score - a.score || b.e.p - a.e.p);
  return res.slice(0, limit);
}
