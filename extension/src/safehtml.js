// Renders untrusted article HTML into DOM nodes without ever using innerHTML.
// The HTML is parsed in an inert document (no scripts run, nothing loads), then only allowed
// elements and attributes are copied across. Everything else is dropped or unwrapped.
const KEEP = new Set(["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "a", "em", "strong", "b", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "code", "pre", "kbd", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "dl", "dt", "dd", "abbr", "cite", "q", "time", "span", "div", "section", "article", "details", "summary"]);
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "select", "textarea", "svg", "math", "noscript", "template", "link", "meta", "base", "canvas", "audio", "video", "source", "track", "head", "title"]);
const safeUrl = (u, schemes) => { try { const x = new URL(u, "https://invalid.example/"); return schemes.includes(x.protocol) && x.host !== "invalid.example" ? x.href : null; } catch { return null; } };

export function renderSafe(html, doc = document, maxNodes = 6000) {
  const P = (doc.defaultView || globalThis).DOMParser;
  const parsed = new P().parseFromString(String(html || ""), "text/html");
  const frag = doc.createDocumentFragment(); let budget = maxNodes;
  const walk = (src, out) => {
    for (const n of Array.from(src.childNodes)) {
      if (budget <= 0) return;
      if (n.nodeType === 3) { out.appendChild(doc.createTextNode(n.nodeValue)); budget--; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.localName;
      if (DROP.has(tag)) continue;
      if (!KEEP.has(tag)) { walk(n, out); continue; }
      const el = doc.createElement(tag); budget--;
      if (tag === "a") { const h = safeUrl(n.getAttribute("href"), ["http:", "https:", "mailto:"]); if (h) { el.setAttribute("href", h); el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); } }
      else if (tag === "img") {
        const s = safeUrl(n.getAttribute("src"), ["https:"]); if (!s) continue;
        el.setAttribute("src", s); el.setAttribute("alt", (n.getAttribute("alt") || "").slice(0, 300)); el.setAttribute("loading", "lazy"); el.setAttribute("referrerpolicy", "no-referrer"); out.appendChild(el); continue;
      } else if (tag === "td" || tag === "th") { for (const a of ["colspan", "rowspan"]) { const v = n.getAttribute(a); if (v && /^\d{1,2}$/.test(v)) el.setAttribute(a, v); } }
      else if (tag === "time") { const v = n.getAttribute("datetime"); if (v && /^[\d\-T:.+Z ]{4,40}$/.test(v)) el.setAttribute("datetime", v); }
      walk(n, el); out.appendChild(el);
    }
  };
  walk(parsed.body || parsed, frag);
  return frag;
}
