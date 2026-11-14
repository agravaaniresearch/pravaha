// Anchor bolding: bolds the first part of each word so the eye has a fixed point to land on.
// The word rules come from Bionify (GPL-3.0), vendored in extension/vendor/bionify.mjs. This module
// only applies them to text nodes of an already sanitised tree and builds DOM nodes, never HTML.
import { parseAlgorithm, bionifyText, MIN_NODE_LENGTH } from "../vendor/bionify.mjs";

const SKIP = new Set(["pre", "code", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "textarea"]);
export const STRENGTHS = [1, 2, 3, 4, 5]; // 1 = light, 5 = strong
// Strength 3 is Bionify's own default, ratio 0.4. The other steps move the ratio by 0.1.
const RATIO = { 1: 0.2, 2: 0.3, 3: 0.4, 4: 0.5, 5: 0.6 };
const algorithmFor = (strength) => parseAlgorithm(`- 0 1 1 2 ${RATIO[Math.min(5, Math.max(1, Math.round(strength)))]}`);

// Returns pieces [{text, kind}] where kind is "highlight", "rest" or "plain".
export function pieces(text, strength = 3) { return bionifyText(String(text), algorithmFor(strength)); }
export const runs = (text, strength = 3) => pieces(text, strength).map(p => ({ text: p.text, bold: p.kind === "highlight" }));

export function anchorTree(root, strength = 3, doc = root.ownerDocument || document) {
  const walk = (node) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) {
        const v = n.nodeValue;
        if (v.length <= MIN_NODE_LENGTH || !/\p{Script=Latin}/u.test(v)) continue; // Latin script only, and upstream's length rule
        const frag = doc.createDocumentFragment();
        for (const p of pieces(v, strength)) {
          if (p.kind === "plain") { frag.appendChild(doc.createTextNode(p.text)); continue; }
          const s = doc.createElement("span"); s.className = p.kind === "highlight" ? "bf" : "br"; s.textContent = p.text; frag.appendChild(s);
        }
        node.replaceChild(frag, n);
      } else if (n.nodeType === 1 && !SKIP.has(n.localName) && n.className !== "bf" && n.className !== "br") walk(n);
    }
  };
  walk(root); return root;
}
