// Look-and-feel preferences. They live in localStorage on this machine and apply instantly.
export const READ_FONTS = [["newsreader", "Newsreader"], ["literata", "Literata"], ["newyork", "New York"], ["sourceserif", "Source Serif"], ["lora", "Lora"], ["crimson", "Crimson Pro"], ["merriweather", "Merriweather"], ["system", "System serif"], ["atkinson", "Atkinson Hyperlegible"], ["sfpro", "SF Pro"], ["ubuntu", "Ubuntu"]];
export const UI_FONTS = [["plex", "IBM Plex Sans"], ["sourcesans", "Source Sans"], ["atkinson", "Atkinson Hyperlegible"], ["sfpro", "SF Pro"], ["ubuntu", "Ubuntu"], ["system", "System"]];
// What each font is, in plain words. kind: serif or sans. apple: built locally from tools/apple-fonts.py, never shipped in the repository.
export const FONT_INFO = {
  newsreader: { kind: "serif", note: "Made for reading news on screen. The default." },
  literata: { kind: "serif", note: "Made for e-books. Sturdy and even at small sizes." },
  newyork: { kind: "serif", note: "Apple's reading serif. Adjusts its shapes to the text size.", apple: "Pravaha New York" },
  sourceserif: { kind: "serif", note: "Clear and a little crisp. Good for dense text." },
  lora: { kind: "serif", note: "Warm and brush-like. Relaxed for long pieces." },
  crimson: { kind: "serif", note: "Classic book type. Light and elegant; try a larger size." },
  merriweather: { kind: "serif", note: "Wide and heavy. Easy to read on small or dim screens." },
  system: { kind: "serif", note: "Whatever serif your computer provides." },
  atkinson: { kind: "sans", note: "Made so look-alike letters are easy to tell apart." },
  sfpro: { kind: "sans", note: "Apple's system font. Clean and compact.", apple: "Pravaha SF Pro" },
  ubuntu: { kind: "sans", note: "Open, friendly shapes. Comfortable at medium sizes." },
  plex: { kind: "sans", note: "Neutral and precise. The default." },
  sourcesans: { kind: "sans", note: "Light and narrow. Fits more on a line." },
};
export const CONFIRM_MODES = [["never", "Never ask"], ["bulk", "Sections and mark all"], ["always", "Always ask"]];
export const DEFAULTS = { theme: "auto", palette: "ember", density: "comfortable", thumbs: true, scrollRead: false, side: true, readFont: "newsreader", uiFont: "plex", confirmRead: "bulk", readSize: 19, readLine: 1.7, readWidth: 68, anchor: false, anchorLevel: 3 };
const KEY = "pravaha.ui";
export function loadPrefs(fallbackTheme) {
  let p = {}; try { p = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
  const out = { ...DEFAULTS, ...(fallbackTheme && !p.theme ? { theme: fallbackTheme } : {}), ...p };
  out.readSize = clamp(out.readSize, 15, 26); out.readLine = clamp(out.readLine, 1.3, 2); out.readWidth = clamp(out.readWidth, 46, 90); out.anchor = out.anchor === true; out.anchorLevel = Math.round(clamp(out.anchorLevel, 1, 5));
  if (!["light", "dark", "oled", "auto"].includes(out.theme)) out.theme = "auto";
  if (!READ_FONTS.some(f => f[0] === out.readFont)) out.readFont = "newsreader";
  if (!UI_FONTS.some(f => f[0] === out.uiFont)) out.uiFont = "plex";
  if (!CONFIRM_MODES.some(f => f[0] === out.confirmRead)) out.confirmRead = "bulk";
  return out;
}
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || lo));
export function resolveTheme(t, prefersDark) { return t === "auto" ? (prefersDark ? "dark" : "light") : t; }
export function applyPrefs(p, root = document.documentElement, prefersDark = false) {
  root.dataset.theme = resolveTheme(p.theme, prefersDark);
  root.style.setProperty("--read-font", `var(--serif-${READ_FONTS.some(f => f[0] === p.readFont) ? p.readFont : "newsreader"})`);
  root.style.setProperty("--ui", `var(--ui-${UI_FONTS.some(f => f[0] === p.uiFont) ? p.uiFont : "plex"})`);
  root.style.setProperty("--read-size", p.readSize + "px"); root.style.setProperty("--read-line", String(p.readLine)); root.style.setProperty("--read-width", p.readWidth + "ch");
}
