// Small DOM helpers. Text is always inserted as text nodes, never as HTML.
const NS = "http://www.w3.org/2000/svg";
const PATHS = {
  chev: "M9 6l6 6-6 6", star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z", x: "M6 6l12 12M18 6L6 18", down: "M6 9l6 6 6-6",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5", ext: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  list: "M4 6h16M4 12h16M4 18h10", bolt: "M13 3L5 14h6l-1 7 8-11h-6z", chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  sync: "M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  coffee: "M17 8h1a4 4 0 010 8h-1M3 8h14v9a4 4 0 01-4 4H7a4 4 0 01-4-4zM6 2v3M10 2v3M14 2v3", check: "M5 12l5 5L20 7",
  up2: "M7 11l5-5 5 5M7 18l5-5 5 5", down2: "M7 6l5 5 5-5M7 13l5 5 5-5",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z", moon: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z",
  msg: "M4 5h16v11H9l-5 4z", play: "M8 5v14l11-7z", music: "M9 18V5l11-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z",
  scroll: "M12 4v12M6 12l6 6 6-6M5 21h14", undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3", menu: "M4 6h16M4 12h16M4 18h16", grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  plus: "M12 5v14M5 12h14", up: "M6 15l6-6 6 6", info: "M12 11v5M12 8h.01M12 3a9 9 0 100 18 9 9 0 000-18z", warn: "M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z", ok: "M8 12l3 3 5-6M12 3a9 9 0 100 18 9 9 0 000-18z", rss: "M5 19a1 1 0 100-2 1 1 0 000 2zM4 11a9 9 0 019 9M4 4a16 16 0 0116 16", swap: "M7 4v16M7 4L3 8M7 4l4 4M17 20V4M17 20l-4-4M17 20l4-4",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  palette: "M12 3a9 9 0 000 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 004-4c0-4.4-4-8-9-8zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  laptop: "M5 6h14v9H5zM3 19h18",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10",
  gauge: "M4 17a8 8 0 1116 0M12 17l4-5",
  devices: "M3 7h12v8H3zM1 19h16M18 9h4v10h-4z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  clock: "M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z", bookmark: "M6 3h12v18l-6-4-6 4z", help: "M9.5 9a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 4M12 17h.01M12 3a9 9 0 100 18 9 9 0 000-18z"
};
// An icon is built once per name, size and fill, then copied. Copying a finished element is much cheaper than setting ten attributes each time,
// and a long list of articles draws hundreds of them.
const ICONS = new Map();
export function icon(name, size = 18, filled = false) {
  const key = name + "|" + size + "|" + (filled ? 1 : 0); let proto = ICONS.get(key);
  if (!proto) {
    proto = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: filled ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) proto.setAttribute(k, String(v));
    const p = document.createElementNS(NS, "path"); p.setAttribute("d", PATHS[name] || ""); proto.appendChild(p); ICONS.set(key, proto);
  }
  return proto.cloneNode(true);
}
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) e.style.setProperty(sk, sv); else e.style[sk] = sv; }
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else if (k === "selected") e.selected = !!v;
    else if (v === true) e.setAttribute(k, ""); else e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
export const pct = (x) => Math.round(x * 100);
export function ago(ms, now = Date.now()) { const m = Math.max(0, (now - ms) / 60000); return m < 60 ? Math.max(1, Math.round(m)) + "m" : m < 1440 ? Math.round(m / 60) + "h" : m < 43200 ? Math.round(m / 1440) + "d" : Math.round(m / 43200) + "mo"; }
export function longAgo(ms, now = Date.now()) {
  const m = Math.max(0, (now - ms) / 60000); const f = (n, u) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (m < 60) return f(Math.max(1, Math.round(m)), "minute"); if (m < 1440) return f(Math.round(m / 60), "hour");
  if (m < 43200) return f(Math.round(m / 1440), "day"); return f(Math.round(m / 43200), "month");
}
