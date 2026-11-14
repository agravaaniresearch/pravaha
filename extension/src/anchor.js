// Anchor bolding: bolds the first part of each word so the eye has a fixed point to land on.
// The word-splitting is done by text-vide (MIT, vendored in extension/vendor). This module only
// applies it to text nodes of an already sanitised tree, so no HTML string is ever parsed here.
import { textVide } from "../vendor/text-vide.mjs";

const SKIP = new Set(["pre", "code", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "textarea"]);
const OPEN = "", CLOSE = "";
export const STRENGTHS = [1, 2, 3, 4, 5]; // 1 = light, 5 = strong

export function anchorText(text, strength = 3) {
  const clean = String(text).replace(/[]/g, "");
  const fixation = 6 - Math.min(5, Math.max(1, Math.round(strength)));
  // ignoreHtml* are off because this is plain text: a literal "<" or "&amp;" must be treated as text.
  return textVide(clean, { sep: [OPEN, CLOSE], fixationPoint: fixation, ignoreHtmlTag: false, ignoreHtmlEntity: false });
}

// Returns an array of {text, bold} runs for one string.
export function runs(text, strength = 3) {
  const out = []; let bold = false; let buf = "";
  for (const ch of anchorText(text, strength)) {
    if (ch === OPEN || ch === CLOSE) { if (buf) out.push({ text: buf, bold }); buf = ""; bold = ch === OPEN; } else buf += ch;
  }
  if (buf) out.push({ text: buf, bold });
  return out;
}

export function anchorTree(root, strength = 3, doc = root.ownerDocument || document) {
  const walk = (node) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) {
        if (!/\p{L}/u.test(n.nodeValue)) continue;
        const frag = doc.createDocumentFragment();
        for (const r of runs(n.nodeValue, strength)) {
          if (!r.bold) { frag.appendChild(doc.createTextNode(r.text)); continue; }
          const s = doc.createElement("span"); s.className = "bf"; s.textContent = r.text; frag.appendChild(s);
        }
        node.replaceChild(frag, n);
      } else if (n.nodeType === 1 && !SKIP.has(n.localName) && !n.classList.contains("bf")) walk(n);
    }
  };
  walk(root); return root;
}
