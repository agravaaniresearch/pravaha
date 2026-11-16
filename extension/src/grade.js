// Colour grading for relevance. 0.8.0: a gentle odds stretch instead of score/0.65 clipped at 1, so the top of the list
// stays distinguishable (the reworked engine scores higher than 0.7.0 did). Strictly increasing; never clips.
import { displayOf } from "./scoring.js";
export const DISPLAY_ODDS = 1.25;
const num = (x) => (Number.isFinite(x) ? x : 0);
export const disp = (score) => displayOf(num(score), DISPLAY_ODDS);
const PALETTES = {
  ember: ["#ecdcb8", "#f2b84b", "#e08a00", "#a8480f"],
  saffron: ["#f0e8c8", "#f4d35e", "#f0a202", "#c75b00"],
  moss: ["#e3e6cc", "#b9cc7a", "#7ea82a", "#3f5a0c"],
  // 0.8.0: kesar runs saffron into rani pink (made for Jamun), jade suits Lacquer, sindoor suits Khadi.
  kesar: ["#f3dccb", "#ffb46b", "#ff7a3d", "#d6336c"],
  jade: ["#d9efe4", "#8fd9b9", "#2fae84", "#0f6e55"],
  sindoor: ["#f6e1d6", "#f3a37f", "#e2582f", "#9e1f12"]
};
export const PALETTE_NAMES = Object.keys(PALETTES);
// The palette that suits each theme, offered when a theme is chosen.
export const THEME_PALETTE = { light: "ember", dark: "ember", oled: "ember", khadi: "sindoor", jamun: "kesar", lacquer: "jade" };
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export function gradeColor(score, palette = "ember") {
  const stops = PALETTES[palette] || PALETTES.ember; const t = Math.min(1, Math.max(0, num(score))) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i; const a = hex(stops[i]), b = hex(stops[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f)); const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return { bg: `rgb(${c[0]},${c[1]},${c[2]})`, fg: lum > 0.6 ? "#2b2015" : "#fffaf0" };
}
