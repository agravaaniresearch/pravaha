// What the extension itself costs: storage writes, requests and time per poll. Kept small (the last 60 polls and the
// last hour of writes) and saved with the other small keys, so the Sync page can show it after Firefox unloads the page.
export const HOUR = 3600000;
export const AMBER_PER_HOUR = 1024 * 1024, RED_PER_HOUR = 10 * 1024 * 1024;

export function freshHealth() { return { writes: [], polls: [], rebuilds: 0 }; }

// One storage write: when, how many bytes, and whether it touched a heavy key (the article copy, history or search index).
export function noteWrite(h, at, bytes, heavy) {
  h.writes.push([at, bytes, heavy ? 1 : 0]);
  const cut = at - HOUR; while (h.writes.length && h.writes[0][0] < cut) h.writes.shift();
  if (h.writes.length > 400) h.writes.splice(0, h.writes.length - 400);
}
// One poll: when, how long, requests made, bytes written during it, whether it wrote a heavy key, and whether it found anything new.
export function notePoll(h, p) { h.polls.push(p); if (h.polls.length > 60) h.polls.splice(0, h.polls.length - 60); }

export function healthSummary(h, now, extra = {}) {
  const hour = (h.writes || []).filter(w => w[0] >= now - HOUR);
  const perHour = hour.reduce((a, w) => a + w[1], 0), heavyHour = hour.filter(w => w[2]).length;
  const polls = h.polls || []; const last = polls[polls.length - 1] || null;
  const idleHeavy = polls.slice(-10).filter(p => p.heavy && !p.changed).length;
  let state = "green", sentence;
  if (perHour > RED_PER_HOUR) { state = "red"; sentence = `Pravaha wrote ${kb(perHour)} to Firefox's storage in the last hour. That is far more than it should; please send the Sync page to the developer.`; }
  else if (perHour > AMBER_PER_HOUR || idleHeavy) { state = "amber"; sentence = idleHeavy ? `${idleHeavy} of the last ten polls rewrote the article copy or history although nothing had changed.` : `Pravaha wrote ${kb(perHour)} in the last hour, mostly from your own reading. It settles when you stop.`; }
  else sentence = `Running light: ${kb(perHour)} written in the last hour${last ? `, the last poll took ${last.ms} ms and ${last.reqs} request${last.reqs === 1 ? "" : "s"}` : ""}.`;
  return { state, sentence, perHour, heavyHour, last, idleHeavy, rebuilds: h.rebuilds || 0, spark: polls.slice(-30).map(p => p.bytes), ...extra };
}
export function kb(n) { return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`; }
