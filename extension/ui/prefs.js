// Look-and-feel preferences. They live in localStorage on this machine and apply instantly.
export const DEFAULTS = { theme: "auto", palette: "ember", density: "comfortable", thumbs: true, scrollRead: false, side: true, readFont: "newsreader", readSize: 19, readLine: 1.7, readWidth: 68, anchor: false, anchorLevel: 3 };
const KEY = "pravaha.ui";
export function loadPrefs(fallbackTheme) {
  let p = {}; try { p = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
  const out = { ...DEFAULTS, ...(fallbackTheme && !p.theme ? { theme: fallbackTheme } : {}), ...p };
  out.readSize = clamp(out.readSize, 15, 26); out.readLine = clamp(out.readLine, 1.3, 2); out.readWidth = clamp(out.readWidth, 46, 90); out.anchor = out.anchor === true; out.anchorLevel = Math.round(clamp(out.anchorLevel, 1, 5));
  if (!["light", "dark", "oled", "auto"].includes(out.theme)) out.theme = "auto";
  if (!["newsreader", "literata"].includes(out.readFont)) out.readFont = "newsreader";
  return out;
}
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ } }
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || lo));
export function resolveTheme(t, prefersDark) { return t === "auto" ? (prefersDark ? "dark" : "light") : t; }
export function applyPrefs(p, root = document.documentElement, prefersDark = false) {
  root.dataset.theme = resolveTheme(p.theme, prefersDark);
  root.style.setProperty("--read-font", p.readFont === "literata" ? "var(--serif-literata)" : "var(--serif-newsreader)");
  root.style.setProperty("--read-size", p.readSize + "px"); root.style.setProperty("--read-line", String(p.readLine)); root.style.setProperty("--read-width", p.readWidth + "ch");
}
