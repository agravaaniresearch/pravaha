// Look-and-feel preferences. They live in localStorage on this machine and apply instantly.
export const READ_FONTS = [["newsreader", "Newsreader"], ["literata", "Literata"], ["sourceserif", "Source Serif"], ["lora", "Lora"], ["crimson", "Crimson Pro"], ["merriweather", "Merriweather"], ["atkinson", "Atkinson Hyperlegible"], ["system", "System serif"]];
export const UI_FONTS = [["plex", "IBM Plex Sans"], ["sourcesans", "Source Sans"], ["atkinson", "Atkinson Hyperlegible"], ["system", "System"]];
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
