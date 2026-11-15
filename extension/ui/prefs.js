// Look-and-feel preferences. They live in localStorage on this machine and apply instantly.
export const READ_FONTS = [["newyork", "New York"], ["sfpro", "SF Pro"], ["system", "System serif"]];
export const UI_FONTS = [["sfpro", "SF Pro"], ["system", "System"]];
// What each font is, in plain words. kind: serif or sans. apple: built locally from tools/apple-fonts.py, never shipped in the repository.
// Pravaha carries only these two Apple families, one serif and one sans; the system choices cost nothing and are the fallback when the Apple files are not in a build.
export const FONT_INFO = {
  newyork: { kind: "serif", note: "Apple's reading serif. Adjusts its shapes to the text size. The default for articles.", apple: "Pravaha New York" },
  sfpro: { kind: "sans", note: "Apple's system font. Clean and compact. The default for menus and lists.", apple: "Pravaha SF Pro" },
  system: { kind: "serif", note: "Whatever your computer provides." },
};
export const CONFIRM_MODES = [["never", "Never ask"], ["bulk", "Sections and mark all"], ["always", "Always ask"]];
export const DEFAULTS = { theme: "auto", palette: "ember", density: "comfortable", thumbs: true, scrollRead: false, side: true, readFont: "newyork", uiFont: "sfpro", confirmRead: "bulk", readSize: 19, readLine: 1.7, readWidth: 68, anchor: false, anchorLevel: 3 };
const KEY = "pravaha.ui";
export function loadPrefs(fallbackTheme) {
  let p = {}; try { p = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
  return normalisePrefs(p, fallbackTheme);
}
// Also used for preferences that arrive from another machine, so a damaged or odd value can never break the screen.
export function normalisePrefs(p, fallbackTheme) {
  p = p && typeof p === "object" ? p : {};
  const out = { ...DEFAULTS, ...(fallbackTheme && !p.theme ? { theme: fallbackTheme } : {}), ...p };
  out.readSize = clamp(out.readSize, 15, 26); out.readLine = clamp(out.readLine, 1.3, 2); out.readWidth = clamp(out.readWidth, 46, 90); out.anchor = out.anchor === true; out.anchorLevel = Math.round(clamp(out.anchorLevel, 1, 5));
  if (!["light", "dark", "oled", "auto"].includes(out.theme)) out.theme = "auto";
  if (!READ_FONTS.some(f => f[0] === out.readFont)) out.readFont = "newyork";
  if (!UI_FONTS.some(f => f[0] === out.uiFont)) out.uiFont = "sfpro";
  if (!CONFIRM_MODES.some(f => f[0] === out.confirmRead)) out.confirmRead = "bulk";
  return out;
}
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || lo));
export function resolveTheme(t, prefersDark) { return t === "auto" ? (prefersDark ? "dark" : "light") : t; }
export function applyPrefs(p, root = document.documentElement, prefersDark = false) {
  root.dataset.theme = resolveTheme(p.theme, prefersDark);
  root.style.setProperty("--read-font", `var(--serif-${READ_FONTS.some(f => f[0] === p.readFont) ? p.readFont : "newyork"})`);
  root.style.setProperty("--ui", `var(--ui-${UI_FONTS.some(f => f[0] === p.uiFont) ? p.uiFont : "sfpro"})`);
  root.style.setProperty("--read-size", p.readSize + "px"); root.style.setProperty("--read-line", String(p.readLine)); root.style.setProperty("--read-width", p.readWidth + "ch");
}
