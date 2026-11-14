// Sparse TF-IDF vectors as plain objects, so they serialise to JSON with no ceremony.
export class Corpus {
  constructor() { this.n = 0; this.df = Object.create(null); }
  add(tokens) {
    this.n += 1;
    for (const t of new Set(tokens)) this.df[t] = (this.df[t] || 0) + 1;
  }
  idf(t) { return Math.log((this.n + 1) / ((this.df[t] || 0) + 1)) + 1; }
  vector(tokens) {
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    const v = {};
    for (const t in tf) v[t] = (1 + Math.log(tf[t])) * this.idf(t);
    return normalize(v);
  }
}

export function norm(v) { let s = 0; for (const k in v) s += v[k] * v[k]; return Math.sqrt(s); }
export function normalize(v) {
  const n = norm(v); if (!n) return {};
  const o = {}; for (const k in v) o[k] = v[k] / n; return o;
}
export function cosine(a, b) {
  let s = 0; const [x, y] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const k in x) if (y[k]) s += x[k] * y[k];
  return s;
}
export function blend(a, b, rate) { // (1-rate)*a + rate*b, then normalised
  const o = {};
  for (const k in a) o[k] = (1 - rate) * a[k];
  for (const k in b) o[k] = (o[k] || 0) + rate * b[k];
  return normalize(o);
}
export function mean(vectors, weights) {
  const o = {}; let tw = 0;
  vectors.forEach((v, i) => { const w = weights ? weights[i] : 1; tw += w; for (const k in v) o[k] = (o[k] || 0) + v[k] * w; });
  if (!tw) return {};
  return normalize(o);
}
export function prune(v, keep = 400) {
  const ks = Object.keys(v).sort((a, b) => v[b] - v[a] || (a < b ? -1 : 1)).slice(0, keep);
  const o = {}; for (const k of ks) o[k] = Math.round(v[k] * 1e5) / 1e5; return normalize(o);
}
export function topTerms(v, n = 12) {
  return Object.keys(v).sort((a, b) => v[b] - v[a] || (a < b ? -1 : 1)).slice(0, n);
}
