const E = (t) => t == null || t === "", u = (t, n) => Object.keys(t).reduce((e, s) => (n(e[s]) && delete e[s], e), t), _ = (t, n) => ({
  ...n,
  ...u(t, E)
}), H = ["<b>", "</b>"];
const x = (t) => _(t, {
  sep: H,
  fixationPoint: 1,
  ignoreHtmlTag: !0,
  ignoreHtmlEntity: !0
}), m = [
  [0, 4, 12, 17, 24, 29, 35, 42, 48],
  [1, 2, 7, 10, 13, 14, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49],
  [
    1,
    2,
    5,
    7,
    9,
    11,
    13,
    15,
    17,
    19,
    21,
    23,
    25,
    27,
    29,
    31,
    33,
    35,
    37,
    39,
    41,
    43,
    45,
    47,
    49
  ],
  [
    0,
    2,
    4,
    5,
    6,
    8,
    9,
    11,
    14,
    15,
    17,
    18,
    20,
    0,
    21,
    23,
    24,
    26,
    27,
    29,
    30,
    32,
    33,
    35,
    36,
    38,
    39,
    41,
    42,
    44,
    45,
    47,
    48
  ],
  [
    0,
    2,
    3,
    5,
    6,
    7,
    8,
    10,
    11,
    12,
    14,
    15,
    17,
    19,
    20,
    21,
    23,
    24,
    25,
    26,
    28,
    29,
    30,
    32,
    33,
    34,
    35,
    37,
    38,
    39,
    41,
    42,
    43,
    44,
    46,
    47,
    48
  ]
], y = (t, n) => {
  const { length: i } = t, e = m[n - 1] ?? m[0], s = e.findIndex(
    (c) => i <= c
  );
  let o = i - s;
  return s === -1 && (o = i - e.length), Math.max(o, 0);
}, R = (t, n) => typeof n == "string" ? `${n}${t}${n}` : `${n[0]}${t}${n[1]}`, A = (t) => {
  const n = [];
  let i = 0;
  for (; i < t.length; ) {
    const e = t.indexOf("<", i);
    if (e === -1)
      break;
    if (t.startsWith("<!--", e)) {
      const o = t.indexOf("-->", e + 4);
      if (o !== -1) {
        n.push([e, o + 2]), i = o + 3;
        continue;
      }
    }
    const s = t.indexOf(">", e + 1);
    if (s === -1)
      break;
    s > e + 1 && n.push([e, s]), i = s + 1;
  }
  return n;
}, N = (t) => {
  const i = A(t).reverse();
  return (e) => {
    const s = e.index, o = i.find(
      ([a]) => s > a
    );
    if (!o)
      return !1;
    const [, c] = o;
    return s < c;
  };
}, O = (t) => Array.from(t).map((n) => {
  const i = n.index, [e] = n, { length: s } = e;
  return [i, i + s - 1];
}), p = /&[\w#]+;/g, F = (t) => {
  const n = t.matchAll(p), e = O(n).reverse();
  return (s) => {
    const o = s.index, c = e.find(
      ([l]) => o > l
    );
    if (!c)
      return !1;
    const [, r] = c;
    return o < r;
  };
}, M = new RegExp("(\\p{L}|\\p{Nd})*\\p{L}(\\p{L}|\\p{Nd})*", "gu"), G = (t, n = {}) => {
  if (!t?.length)
    return "";
  const { fixationPoint: i, sep: e, ignoreHtmlTag: s, ignoreHtmlEntity: o } = x(n), c = Array.from(t.matchAll(M));
  let r = "", a = 0, l;
  s && (l = N(t));
  let h;
  o && (h = F(t));
  for (const g of c) {
    if (l?.(g) || h?.(g))
      continue;
    const [f] = g, d = g.index, T = d + y(f, i), I = t.slice(a, d);
    r += I, d !== T && (r += R(t.slice(d, T), e)), a = T;
  }
  const L = t.slice(a);
  return r + L;
};
export {
  G as textVide
};
