import { AbsoluteFill, Sequence, Img, staticFile, useCurrentFrame, interpolate, spring, useVideoConfig, Easing } from "remotion";

const C = { bg: "#170b1b", surface: "#1f1024", line: "#3a2443", text: "#f1e6dc", muted: "#b6a3b3", kesar: "#ffa149", rani: "#d6336c", jade: "#4cc9a0", ox: "#130908" };
const serif = "Georgia, 'Noto Serif', serif"; const sans = "system-ui, 'Noto Sans', sans-serif";
const SCENES = [["title", 120], ["light", 210], ["deadline", 150], ["rank", 240], ["hot", 150], ["themes", 210], ["pane", 180], ["end", 150]];
const FADE = 15;
export const TOTAL = SCENES.reduce((n, [, d]) => n + d, 0) - FADE * (SCENES.length - 1);

const useIn = (delay = 0) => { const f = useCurrentFrame(); const { fps } = useVideoConfig(); return spring({ frame: f - delay, fps, config: { damping: 200 } }); };
const Fade = ({ dur, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, FADE, dur - FADE, dur], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};
const Bg = ({ children, tint = C.kesar }) => (
  <AbsoluteFill style={{ background: `radial-gradient(70% 60% at 30% 25%, ${tint}22, transparent 70%), ${C.bg}`, color: C.text, fontFamily: sans, padding: "110px 140px" }}>{children}</AbsoluteFill>
);
const Kicker = ({ children, color = C.kesar }) => { const s = useIn(0); return <div style={{ fontSize: 30, letterSpacing: 6, textTransform: "uppercase", color, opacity: s, transform: `translateY(${(1 - s) * 20}px)` }}>{children}</div>; };
const H = ({ children, d = 4, size = 92 }) => { const s = useIn(d); return <div style={{ fontFamily: serif, fontSize: size, lineHeight: 1.08, marginTop: 18, opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>{children}</div>; };
const P = ({ children, d = 12 }) => { const s = useIn(d); return <div style={{ fontSize: 36, color: C.muted, marginTop: 26, maxWidth: 1450, lineHeight: 1.4, opacity: s }}>{children}</div>; };
const Note = () => <div style={{ position: "absolute", bottom: 40, left: 140, fontSize: 22, color: C.muted, opacity: 0.8 }}>Synthetic data and headless benchmarks; illustrative only.</div>;

const Count = ({ from, to, unit, label, d }) => {
  const f = useCurrentFrame(); const t = interpolate(f, [d + 20, d + 70], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }); const s = useIn(d);
  const ints = Number.isInteger(from[0]) && Number.isInteger(to[0]); const fmt = (v) => (ints || v >= 10 ? Math.round(v) : v.toFixed(1));
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 24, padding: "38px 44px", width: 500, opacity: s, transform: `translateY(${(1 - s) * 40}px)` }}>
      <div style={{ fontSize: 28, color: C.muted, height: 76 }}>{label}</div>
      <div style={{ fontSize: 30, color: C.muted, textDecoration: "line-through", marginTop: 10 }}>{from[0]} {from[1]}</div>
      <div style={{ fontFamily: serif, fontSize: 104, color: C.kesar, marginTop: 6 }}>{fmt(from[0] + (to[0] - from[0]) * t)}<span style={{ fontSize: 44, marginLeft: 12 }}>{t < 0.5 ? from[1] : to[1]}</span></div>
    </div>
  );
};
const Bar = ({ label, before, after, d, color }) => {
  const f = useCurrentFrame(); const t = interpolate(f, [d + 30, d + 80], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) }); const v = before + (after - before) * t; const s = useIn(d);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 30, marginTop: 56, opacity: s }}>
      <div style={{ width: 520, fontSize: 32 }}>{label}</div>
      <div style={{ flex: 1, height: 34, background: C.line, borderRadius: 17, overflow: "hidden" }}><div style={{ width: `${v * 100}%`, height: "100%", background: color, borderRadius: 17 }} /></div>
      <div style={{ width: 120, fontSize: 40, fontFamily: serif, textAlign: "right" }}>{v.toFixed(2)}</div>
    </div>
  );
};
const Shot = ({ src, d = 0, w = 1640, style = {} }) => { const s = useIn(d); return <Img src={staticFile(src)} style={{ width: w, borderRadius: 18, border: `1px solid ${C.line}`, boxShadow: "0 40px 90px -30px rgba(0,0,0,.8)", opacity: s, transform: `translateY(${(1 - s) * 40}px) scale(${0.97 + 0.03 * s})`, ...style }} />; };

const scenes = {
  title: () => <Bg><div style={{ marginTop: 200 }}><Kicker>Pravaha 0.8.0</Kicker><H size={140}>Lighter. Sharper. Wider.</H><P>A senior code review, a mathematical review of the relevance engine, and a design pass, in one release.</P></div></Bg>,
  light: () => <Bg><Kicker>Runs light</Kicker><H>An idle poll now costs almost nothing.</H>
    <div style={{ display: "flex", gap: 40, marginTop: 70 }}>
      <Count label="Written to storage on an idle poll" from={[6.6, "MB"]} to={[1, "KB"]} d={20} />
      <Count label="Requests on a poll after a wake" from={[19, ""]} to={[5, ""]} d={35} />
      <Count label="Open a card and redraw" from={[336, "ms"]} to={[77, "ms"]} d={50} />
    </div><Note /></Bg>,
  deadline: () => <Bg tint={C.jade}><Kicker color={C.jade}>Never hangs</Kicker><H>Every request has a deadline.</H><P>A server that never answered used to freeze syncing until Firefox restarted. Now Miniflux, WebDAV and Raindrop give up in 30 to 90 seconds, say so in a sentence, and the next poll tries again. With no Pravaha tab open, polls run at most every ten minutes.</P></Bg>,
  rank: () => <Bg tint={C.rani}><Kicker color={C.rani}>Ranking, reworked</Kicker><H size={76}>Standing is now the share you read, not the count.</H><div style={{ height: 40 }} />
    <Bar label="Firehose: 100 a day, 2 opened" before={1} after={0.39} d={30} color={C.rani} />
    <Bar label="Small feed, read in full" before={1} after={0.96} d={40} color={C.kesar} />
    <P d={110}>Best-tag matching, a profile that keeps your Raindrop saves, one open counted once. On-topic articles in the top 100: 87 before, 100 now.</P><Note /></Bg>,
  hot: () => { const s = useIn(25); return <Bg><Kicker>Hot stories</Kicker><H>The same story across your feeds rises.</H><P>Fever-style: articles from different feeds within 36 hours that say the same thing are counted together.</P>
    <div style={{ marginTop: 60, display: "inline-flex", alignItems: "center", gap: 14, fontSize: 48, fontWeight: 700, background: C.kesar, color: C.bg, borderRadius: 40, padding: "16px 36px", transform: `scale(${0.6 + 0.4 * s})`, opacity: s }}>🔥 3 feeds</div></Bg>; },
  themes: () => { const f = useCurrentFrame(); const x = interpolate(f, [20, 190], [0, -900], { extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
    return <Bg tint={C.jade}><Kicker color={C.jade}>Three new themes</Kicker><H size={76}>Khadi, Jamun and Lacquer.</H>
      <div style={{ display: "flex", gap: 50, marginTop: 50, transform: `translateX(${x}px)` }}><Shot src="jamun-feed.png" w={1100} d={10} /><Shot src="lacquer-feed.png" w={1100} d={20} /><Shot src="khadi-card.png" w={1100} d={30} /></div></Bg>; },
  pane: () => <Bg><Kicker>Ultrawide</Kicker><H size={70}>At 1800 pixels and wider, the article reads beside the list.</H><div style={{ marginTop: 50 }}><Shot src="uw-card.png" w={1640} d={15} /></div></Bg>,
  end: () => <Bg tint={C.jade}><div style={{ marginTop: 230 }}><Kicker color={C.jade}>Install</Kicker><H size={110}>pravaha-0.8.0.xpi</H><P>about:addons, the gear icon, Install Add-on From File. 256 tests pass. Checked in real Firefox 160 against fake servers.</P></div><Note /></Bg>,
};

export const Video = () => { let at = 0; return <AbsoluteFill style={{ background: C.bg }}>{SCENES.map(([k, d], i) => { const from = at; at += d - FADE; const S = scenes[k]; return <Sequence key={k} from={from} durationInFrames={d}><Fade dur={d}><S /></Fade></Sequence>; })}</AbsoluteFill>; };
