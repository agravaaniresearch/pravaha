// Colour grading for relevance. Raw scores rarely pass 0.65, so the display is stretched: 65 raw is a full bar.
export const DISPLAY_SCALE = 0.65;
const num = (x) => (Number.isFinite(x) ? x : 0);
export const disp = (score) => Math.min(1, Math.max(0, num(score)) / DISPLAY_SCALE);
const PALETTES = {
  ember: ["#ecdcb8", "#f2b84b", "#e08a00", "#a8480f"],
  saffron: ["#f0e8c8", "#f4d35e", "#f0a202", "#c75b00"],
  moss: ["#e3e6cc", "#b9cc7a", "#7ea82a", "#3f5a0c"]
};
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export function gradeColor(score, palette = "ember") {
  const stops = PALETTES[palette] || PALETTES.ember; const t = Math.min(1, Math.max(0, num(score))) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i; const a = hex(stops[i]), b = hex(stops[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f)); const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return { bg: `rgb(${c[0]},${c[1]},${c[2]})`, fg: lum > 0.6 ? "#2b2015" : "#fffaf0" };
}
