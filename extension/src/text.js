// Tokenising and light stemming. No dependencies, deterministic.
const STOP = new Set(("a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your said says say new one two also may might still per via").split(/\s+/));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("ly") && w.length > 5) return w.slice(0, -2);
  if (/(?:ss|x|z|ch|sh)es$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().replace(/<[^>]*>/g, " ").split(/[^\p{L}\p{N}]+/u);
  const out = [];
  for (const t of raw) {
    if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) continue;
    out.push(stem(t));
  }
  return out;
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function wordCount(html) { const m = String(html || "").replace(/<[^>]*>/g, " ").match(/\S+/g); return m ? m.length : 0; }
export function firstParagraph(html, max = 320) {
  const plain = String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + "…" : plain;
}

// One address for one page: no scheme, no www, no fragment, no tracking parameters, no trailing slash. Used to recognise an article you saved in Raindrop.
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|yclid$|_hsenc$|_hsmi$)/;
export function canonicalUrl(u) {
  try {
    const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol)) return "";
    const keep = [...x.searchParams.entries()].filter(([k]) => !TRACKING.test(k.toLowerCase())).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const q = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
    return x.hostname.toLowerCase().replace(/^www\./, "") + (x.pathname.replace(/\/+$/, "") || "") + q;
  } catch { return ""; }
}
