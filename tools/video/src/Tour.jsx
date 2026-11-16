import { AbsoluteFill, Sequence, Img, staticFile, useCurrentFrame, interpolate, spring, useVideoConfig, Easing } from "remotion";
import NOTES from "../public/tour/notes.json";
const C = { bg: "#170b1b", surface: "#1f1024", line: "#3a2443", text: "#f1e6dc", muted: "#b6a3b3", kesar: "#ffa149", rani: "#e04a7a", jade: "#4cc9a0" };
const serif = "Georgia, 'Noto Serif', serif"; const sans = "system-ui, 'Noto Sans', sans-serif";
const FPS = 30, FADE = 24, STEP = 86, INTRO = 90, HOLD = 75;
const ease = (f, a, b) => interpolate(f, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
const useIn = (d = 0) => { const f = useCurrentFrame(); const { fps } = useVideoConfig(); return spring({ frame: f - d, fps, config: { damping: 200, mass: 1.4 } }); };
const Fade = ({ dur, children }) => { const f = useCurrentFrame(); const o = interpolate(f, [0, FADE, dur - FADE, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }); return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>; };
const Bg = ({ children, tint = C.kesar, pad = "120px 140px" }) => <AbsoluteFill style={{ background: `radial-gradient(70% 60% at 30% 25%, ${tint}22, transparent 70%), ${C.bg}`, color: C.text, fontFamily: sans, padding: pad }}>{children}</AbsoluteFill>;
const K = ({ children, color = C.kesar }) => { const s = useIn(0); return <div style={{ fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color, opacity: s }}>{children}</div>; };
const H = ({ children, d = 6, size = 80 }) => { const s = useIn(d); return <div style={{ fontFamily: serif, fontSize: size, lineHeight: 1.1, marginTop: 14, opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>{children}</div>; };
const P = ({ children, d = 18 }) => { const s = useIn(d); return <div style={{ fontSize: 36, color: C.muted, marginTop: 26, maxWidth: 1500, lineHeight: 1.45, opacity: s }}>{children}</div>; };

// A screenshot with numbered callouts: each note highlights its element and an arrow runs to it from the label column.
const Annotated = ({ shot, kicker, title, color = C.kesar }) => {
  const f = useCurrentFrame(); const S = NOTES[shot]; const W = 1300, X = 70, Y = 190; const sc = W / S.w; const H0 = S.h * sc;
  const n = S.notes.length; const active = Math.min(n - 1, Math.floor((f - INTRO) / STEP));
  const LX = X + W + 60, LW = 1920 - LX - 50; const gap = Math.min(150, (1080 - Y - 60) / n);
  const zoom = interpolate(f, [0, INTRO + n * STEP + HOLD], [1, 1.03]);
  const img = useIn(4);
  return <Bg tint={color} pad="56px 70px">
    <K color={color}>{kicker}</K><div style={{ fontFamily: serif, fontSize: 52, marginTop: 6 }}>{title}</div>
    <div style={{ position: "absolute", left: X, top: Y, width: W, height: H0, transform: `scale(${zoom})`, transformOrigin: "center", opacity: img }}>
      <Img src={staticFile(`tour/${shot}.png`)} style={{ width: W, borderRadius: 14, border: `1px solid ${C.line}`, boxShadow: "0 40px 90px -30px rgba(0,0,0,.85)" }} />
    </div>
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}>
      <defs><marker id={`ah-${shot}`} markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 z" fill={color} /></marker></defs>
      {S.notes.map((nt, i) => {
        const t = ease(f, INTRO + i * STEP, INTRO + i * STEP + 24); if (t <= 0) return null;
        const [bx, by, bw, bh] = nt.box.map(v => v * sc); const rx = X + Math.max(0, bx), ry = Y + Math.max(0, by), rw = Math.min(bw, W - bx), rh = Math.min(bh, H0 - by);
        const ly = Y + 20 + i * gap + 22; const tx = rx + rw, ty = ry + Math.min(rh, 60) / 2 + (rh > 60 ? 10 : 0);
        const on = i === active; const op = on ? 1 : 0.3;
        const len = Math.hypot(LX - 14 - tx, ly - ty); const mx = (LX + tx) / 2;
        return <g key={i} opacity={op}>
          <rect x={rx - 4} y={ry - 4} width={rw + 8} height={rh + 8} rx={8} fill="none" stroke={color} strokeWidth={on ? 3 : 2} style={{ filter: on ? `drop-shadow(0 0 10px ${color})` : "none" }} opacity={t} />
          {on && <path d={`M ${LX - 14} ${ly} C ${mx} ${ly}, ${mx} ${ty}, ${tx + 8} ${ty}`} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray={len * 1.4} strokeDashoffset={len * 1.4 * (1 - t)} markerEnd={t > 0.95 ? `url(#ah-${shot})` : undefined} />}
        </g>;
      })}
    </svg>
    {S.notes.map((nt, i) => { const t = ease(f, INTRO + i * STEP, INTRO + i * STEP + 18); const on = i === active;
      return <div key={i} style={{ position: "absolute", left: LX, top: Y + 20 + i * gap, width: LW, opacity: t * (on ? 1 : 0.45), transform: `translateX(${(1 - t) * 20}px)`, display: "flex", gap: 14 }}>
        <div style={{ flex: "none", width: 44, height: 44, borderRadius: 22, background: on ? color : C.line, color: on ? C.bg : C.text, fontWeight: 700, fontSize: 24, display: "grid", placeItems: "center" }}>{i + 1}</div>
        <div style={{ fontSize: on ? 30 : 26, lineHeight: 1.3, color: on ? C.text : C.muted }}>{nt.label}</div></div>; })}
  </Bg>;
};
const lenOf = (shot) => INTRO + NOTES[shot].notes.length * STEP + HOLD;

const Arch = () => { const f = useCurrentFrame();
  const B = ({ x, y, w = 360, h = 130, t, s, c = C.kesar, d }) => { const k = ease(f, d, d + 20); return <g opacity={k}><rect x={x} y={y} width={w} height={h} rx={18} fill={C.surface} stroke={c} strokeWidth={2.5} /><text x={x + w / 2} y={y + 55} textAnchor="middle" fill={C.text} fontSize={38} fontFamily={serif}>{t}</text><text x={x + w / 2} y={y + 98} textAnchor="middle" fill={C.muted} fontSize={22} fontFamily={sans}>{s}</text></g>; };
  const A = ({ d: path, at, label, lx, ly, c = C.kesar }) => { const k = ease(f, at, at + 30); return <g><path d={path} fill="none" stroke={c} strokeWidth={3} strokeDasharray={900} strokeDashoffset={900 * (1 - k)} markerEnd={k > 0.95 ? "url(#arch)" : undefined} /><text x={lx} y={ly} fill={c} fontSize={26} fontFamily={sans} opacity={k} stroke={C.bg} strokeWidth={10} paintOrder="stroke">{label}</text></g>; };
  return <Bg><K>How the pieces fit</K><H size={60}>Miniflux holds the feeds. Pravaha is the reader.</H>
    <svg width={1920} height={1080} style={{ position: "absolute", left: 0, top: 0 }}><defs><marker id="arch" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 z" fill={C.kesar} /></marker></defs>
      <B x={780} y={520} t="Pravaha" s="Firefox, on each machine" d={10} />
      <B x={140} y={360} t="Miniflux" s="fetches and stores feeds" d={40} c={C.jade} />
      <B x={1420} y={360} t="Fastmail WebDAV" s="history, training, digest" d={70} c={C.jade} />
      <B x={140} y={780} t="Raindrop" s="4,400 bookmarks" d={100} c={C.rani} />
      <B x={1420} y={780} t="Firefox Sync" s="keys and settings" d={130} c={C.rani} />
      <A d="M 780 570 C 620 570, 620 425, 505 425" at={60} label="read state, batched" lx={545} ly={480} />
      <A d="M 1140 570 C 1300 570, 1300 425, 1415 425" at={90} label="once per poll" lx={1180} ly={480} />
      <A d="M 505 845 C 640 845, 640 640, 775 640" at={120} label="saves teach ranking" lx={520} ly={760} />
      <A d="M 1140 640 C 1280 640, 1280 845, 1415 845" at={150} label="keys travel" lx={1200} ly={760} />
    </svg></Bg>; };

const Points = ({ k, h, items, c = C.kesar }) => <Bg tint={c}><K color={c}>{k}</K><H size={64}>{h}</H><div style={{ marginTop: 30 }}>{items.map((t, i) => { const s = useIn(30 + i * 40); return <div key={i} style={{ fontSize: 34, lineHeight: 1.4, marginTop: 20, opacity: s, transform: `translateX(${(1 - s) * 24}px)`, maxWidth: 1600 }}><span style={{ color: c }}>●</span>&nbsp; {t}</div>; })}</div></Bg>;

const SCENES = [
  [240, () => <Bg><div style={{ marginTop: 230 }}><K>Pravaha · प्रवाह · 0.8.8</K><H size={150}>A reader that flows.</H><P>A guided tour of the screens, the settings, and the choices behind them.</P></div></Bg>],
  [330, () => <Bg tint={C.jade}><div style={{ marginTop: 200 }}><K color={C.jade}>How it was made</K><H>Vibe coded, steered by Dr Abhishek Puri.</H><P>AI models wrote the code. Every goal, trade-off and correction was his, and two of the key fixes came from what he noticed in daily use: a red health light and an empty Raindrop collection.</P></div></Bg>],
  [420, Arch],
  [lenOf("feed"), () => <Annotated shot="feed" kicker="The Newsfeed" title="Grouped by feed, coloured by relevance" />],
  [lenOf("card"), () => <Annotated shot="card" kicker="Reading" title="An article opens in place" color={C.jade} />],
  [lenOf("ultra"), () => <Annotated shot="ultra" kicker="Ultrawide" title="A reading pane beside the list" />],
  [lenOf("s-conn"), () => <Annotated shot="s-conn" kicker="Settings · Connections" title="Three services, each tested in place" color={C.jade} />],
  [lenOf("s-look"), () => <Annotated shot="s-look" kicker="Settings · Look and reading" title="Your themes, colours and reading habits" color={C.rani} />],
  [lenOf("s-feeds"), () => <Annotated shot="s-feeds" kicker="Settings · Feeds" title="Every feed, with its health" />],
  [lenOf("s-rank"), () => <Annotated shot="s-rank" kicker="Settings · Ranking" title="Five signals you can weigh" color={C.rani} />],
  [lenOf("s-move"), () => <Annotated shot="s-move" kicker="Settings · Move setup" title="Set up once, carried everywhere" color={C.jade} />],
  [lenOf("s-machine"), () => <Annotated shot="s-machine" kicker="Settings · This machine" title="What belongs to this computer alone" />],
  [lenOf("sync"), () => <Annotated shot="sync" kicker="Sync" title="Every service in plain sentences" color={C.jade} />],
  [lenOf("stats"), () => <Annotated shot="stats" kicker="Stats" title="Your reading, shown back to you" color={C.rani} />],
  [480, () => <Points k="Decisions he made" h="Light, fresh, and honest about itself." items={["Batch read changes: one request to Miniflux, not forty", "Fetch when you look: Miniflux refreshes as the reader opens", "Poll every thirty minutes; nothing writes when nothing changed", "A health light that flags the extension's own cost", "Private: signed for one reader, never published"]} c={C.jade} />],
  [360, () => <Points k="Left out on purpose" h="Less code, fewer ways to fail." items={["No scraping, no paywall bypass, no read-later shelf", "Every change covered by tests, then checked in real Firefox", "The relevance engine reviewed by a mathematician before release"]} />],
  [300, () => <Bg tint={C.jade}><div style={{ marginTop: 240 }}><K color={C.jade}>Pravaha 0.8.8</K><H size={120}>Read what matters.</H><P>Vibe coded with AI, steered by Dr Abhishek Puri. Screens show synthetic data.</P></div></Bg>],
];
export const TOTAL3 = SCENES.reduce((n, [d]) => n + d, 0) - FADE * (SCENES.length - 1);
export const Tour = () => { let at = 0; return <AbsoluteFill style={{ background: C.bg }}>{SCENES.map(([d, S], i) => { const from = at; at += d - FADE; return <Sequence key={i} from={from} durationInFrames={d}><Fade dur={d}><S /></Fade></Sequence>; })}</AbsoluteFill>; };
