// Append-only event log with a hybrid logical clock. Merging is a set union keyed by event id,
// so the order in which two machines exchange events never changes the outcome.
import { AUTHORITY_SIGNALS, decay } from "./scoring.js";

const pad = (n, w) => String(n).padStart(w, "0");
export function fmtTs(wall, counter, device) { return `${pad(wall, 14)}.${pad(counter, 5)}.${device}`; }
export function parseTs(ts) {
  const [w, c, ...rest] = String(ts).split(".");
  return { wall: Number(w), counter: Number(c), device: rest.join(".") };
}

export class Clock {
  constructor(device, now = () => Date.now()) { this.device = device; this.now = now; this.wall = 0; this.counter = 0; }
  tick() {
    const t = this.now();
    if (t > this.wall) { this.wall = t; this.counter = 0; } else { this.counter += 1; }
    return fmtTs(this.wall, this.counter, this.device);
  }
  observe(ts) {
    const r = parseTs(ts); if (!Number.isFinite(r.wall)) return;
    const t = this.now();
    // A machine whose clock is far ahead must not drag this one into the future (decay would freeze for everyone): adopt at most one day of drift.
    if (r.wall > t + 86400000) return;
    const m = Math.max(this.wall, r.wall, t);
    if (m === this.wall && m === r.wall) this.counter = Math.max(this.counter, r.counter);
    else if (m === r.wall && m !== this.wall) this.counter = r.counter;
    else if (m !== this.wall) this.counter = 0;
    this.wall = m;
  }
}

export const EVENT_TYPES = new Set(["open", "card", "dwell", "dismiss", "undismiss", "save", "unsave", "read_no_open", "train", "calibration", "order"]);

export function validEvent(e) {
  return e && typeof e === "object" && typeof e.eid === "string" && typeof e.ts === "string" &&
    typeof e.device === "string" && EVENT_TYPES.has(e.type) && /^\d{14}\.\d{5}\./.test(e.ts);
}

export class EventLog {
  constructor(device, clock) {
    this.device = device; this.clock = clock || new Clock(device);
    this.byId = new Map(); this.seq = 0; this._sorted = null;
  }
  append(type, fields = {}) {
    this.seq += 1;
    const e = { v: 1, eid: `${this.device}:${this.seq}`, device: this.device, ts: this.clock.tick(), type, ...fields };
    this.byId.set(e.eid, e); this._sorted = null; return e;
  }
  merge(events) {
    let added = 0;
    for (const e of events) {
      if (!validEvent(e) || this.byId.has(e.eid)) continue;
      this.byId.set(e.eid, e); this.clock.observe(e.ts); added += 1;
      if (e.device === this.device) { const n = Number(e.eid.split(":")[1]); if (n > this.seq) this.seq = n; }
    }
    if (added) this._sorted = null;
    return added;
  }
  list() {
    if (!this._sorted) this._sorted = [...this.byId.values()].sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.eid < b.eid ? -1 : 1));
    return this._sorted;
  }
  own() { return [...this.byId.values()].filter(e => e.device === this.device).sort((a, b) => Number(a.eid.split(":")[1]) - Number(b.eid.split(":")[1])); }
  head() { const l = this.list(); return l.length ? l[l.length - 1].ts : null; }
  headOf(device) { let h = null; for (const e of this.byId.values()) if (e.device === device && (!h || e.ts > h)) h = e.ts; return h; }
  count() { return this.byId.size; }
  maxSeqOf(device) { let m = 0; for (const e of this.byId.values()) if (e.device === device) { const n = Number(e.eid.split(":")[1]) || 0; if (n > m) m = n; } return m; }
  countsByDevice() { const c = {}; for (const e of this.byId.values()) c[e.device] = (c[e.device] || 0) + 1; return c; }
}

export const SEGMENT_SIZE = 500;
export function segmentName(index) { return String(index).padStart(4, "0") + ".jsonl"; }
export function toSegmentText(events) { return events.map(e => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""); }
export function parseSegment(text) {
  const events = []; let corrupt = 0;
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (validEvent(e)) events.push(e); else corrupt += 1; } catch { corrupt += 1; }
  }
  return { events, corrupt };
}

// Replay the whole log into derived state. Deterministic: same events, same result.
export function derive(events, now) {
  const cards = new Map(), dismissed = new Map(), saved = new Map(), opens = new Map(), dwell = new Map(), trainMap = new Map();
  const authority = new Map(); const pulls = []; const orders = new Map(); const stories = new Map();
  const bump = (feed, d, ts) => {
    if (feed === undefined || feed === null) return;
    const k = String(feed); const age = Math.max(0, now - parseTs(ts).wall);
    authority.set(k, (authority.get(k) || 0) + d * decay(age));
  };
  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case "open":
        opens.set(e.entry, (opens.get(e.entry) || 0) + 1);
        bump(e.feed, AUTHORITY_SIGNALS.open, e.ts);
        if (p.terms) pulls.push({ kind: "open", terms: p.terms, at: parseTs(e.ts).wall });
        break;
      case "card":
        cards.set(e.entry, (cards.get(e.entry) || 0) + 1);
        bump(e.feed, AUTHORITY_SIGNALS.card, e.ts);
        if (p.terms) pulls.push({ kind: "card", terms: p.terms, at: parseTs(e.ts).wall });
        break;
      case "dwell":
        dwell.set(e.entry, (dwell.get(e.entry) || 0) + (p.ms || 0));
        if ((p.ms || 0) > 15000) bump(e.feed, AUTHORITY_SIGNALS.dwell, e.ts);
        break;
      case "dismiss": dismissed.set(e.entry, true); bump(e.feed, AUTHORITY_SIGNALS.readNoOpen, e.ts); break;
      case "undismiss": dismissed.set(e.entry, false); break;
      case "read_no_open": bump(e.feed, AUTHORITY_SIGNALS.readNoOpen, e.ts); break;
      case "save":
        saved.set(e.entry, true); bump(e.feed, AUTHORITY_SIGNALS.save, e.ts);
        if (p.terms) pulls.push({ kind: "save", terms: p.terms, at: parseTs(e.ts).wall });
        break;
      case "unsave": saved.set(e.entry, false); bump(e.feed, -AUTHORITY_SIGNALS.save, e.ts); break;
      case "order": if (typeof p.scope === "string" && Array.isArray(p.ids)) orders.set(p.scope, { ids: p.ids.map(String), wall: parseTs(e.ts).wall }); break;
      // A thumb on a whole article is stored as a train event of type "story"; it remembers which tag and word rules it set, so it can be undone cleanly.
      case "train":
        if (!Number.isFinite(p.value)) break; // a damaged rule must not zero every matching article
        if (p.type === "story") stories.set(String(p.key), { at: parseTs(e.ts).wall, value: p.value, keys: Array.isArray(p.keys) ? p.keys.filter(k => k && typeof k.type === "string" && typeof k.key === "string").slice(0, 12) : [], terms: Array.isArray(p.terms) ? p.terms.slice(0, 16) : null });
        else trainMap.set(`${p.type}:${p.key}`, { type: p.type, key: p.key, value: Math.max(-3, Math.min(3, p.value)) });
        break;
    }
  }
  const training = [...trainMap.values()].filter(r => r.value !== 0);
  const story = {}; for (const [k, v] of stories) if (v.value === 1 || v.value === -1) { story[k] = v; if (v.value > 0 && v.terms) pulls.push({ kind: "up", terms: v.terms, at: v.at }); }
  return {
    dismissed: new Set([...dismissed].filter(([, v]) => v).map(([k]) => k)),
    saved: new Set([...saved].filter(([, v]) => v).map(([k]) => k)),
    opens, cards, dwell, authorityDelta: Object.fromEntries(authority), training, story, pulls, order: Object.fromEntries(orders)
  };
}
