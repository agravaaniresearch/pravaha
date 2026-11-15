// What the Miniflux server can do, and whether its answers still look the way Pravaha expects.
// Pure functions over the `server` record described in docs/SCHEMA.md ("0.6.0"). Nothing here touches the network.

export const CHECK_EVERY = 6 * 3600 * 1000;
// The release that introduced each thing, from the Miniflux API documentation. Used only to explain; a version never switches a feature on.
export const MIN_VERSION = { version: "2.0.49", entryIds: "2.3.2", afterEntryId: "2.0.9", categoryRefresh: "2.0.42" };

export const freshServer = () => ({
  version: null, checkedAt: null,
  caps: { version: null, entryIds: null, afterEntryId: null, categoryRefresh: null, feedRefresh: null },
  history: [], changed: null, contract: { ok: true, at: null, problems: [], skipped: 0 }
});

// Anything read back from storage is made well-formed, so an old or damaged record can never break a refresh.
export function loadServer(raw) {
  const base = freshServer(); if (!raw || typeof raw !== "object") return base;
  const out = { ...base, ...raw, caps: { ...base.caps, ...(raw.caps || {}) }, contract: { ...base.contract, ...(raw.contract || {}) } };
  out.history = Array.isArray(raw.history) ? raw.history.filter(x => x && typeof x.v === "string").slice(-5) : [];
  if (typeof out.version !== "string") out.version = null;
  if (!out.changed || typeof out.changed.to !== "string") out.changed = null;
  if (!Array.isArray(out.contract.problems)) out.contract.problems = [];
  return out;
}

export function parseVersion(v) { const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || "").trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null; }
export function versionAtLeast(v, min) {
  const a = parseVersion(v), b = parseVersion(min); if (!a || !b) return null;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return true;
}

// Record a version read from GET /version. A different version from the last one seen is a change the reader must be told about.
export function noteVersion(srv, v, now) {
  srv.checkedAt = now; const ver = typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null;
  srv.caps.version = !!ver; if (!ver) return srv;
  if (srv.version !== ver) {
    if (srv.version) srv.changed = { from: srv.changed ? srv.changed.from : srv.version, to: ver, at: now };
    srv.history = [...srv.history, { v: ver, at: now }].slice(-5); srv.version = ver;
    // A different server may offer more or less than the last one, so what it can do is learned again.
    for (const k of ["entryIds", "afterEntryId", "categoryRefresh", "feedRefresh"]) srv.caps[k] = null;
  }
  return srv;
}
export const ackChange = (srv) => { srv.changed = null; return srv; };
export const dueForCheck = (srv, now) => !srv.checkedAt || now - srv.checkedAt > CHECK_EVERY || srv.contract.ok === false;

// A cap becomes true after a good answer and false after "not found" or a well-formed answer without the expected field. Anything else leaves it alone.
export function setCap(srv, name, value) { if (name in srv.caps && (value === true || value === false)) srv.caps[name] = value; return srv; }
export const notFound = (e) => !!e && (e.status === 404 || e.status === 405);

// ---------- the shape of what Miniflux sends ----------
const STATUSES = new Set(["read", "unread", "removed"]);
export const badFeed = (f) => (!f || typeof f !== "object" ? "feed" : !Number.isFinite(f.id) ? "id" : typeof f.title !== "string" ? "title" : !f.category || typeof f.category.title !== "string" ? "category.title" : null);
export const badEntry = (e) => (!e || typeof e !== "object" ? "entry" : !Number.isFinite(e.id) ? "id" : !Number.isFinite(e.feed_id) ? "feed_id" : !STATUSES.has(e.status) ? "status" : !Number.isFinite(Date.parse(e.published_at)) ? "published_at" : null);
export const badIds = (r) => (!r || typeof r !== "object" ? "answer" : !Array.isArray(r.entry_ids) || !r.entry_ids.every(Number.isInteger) ? "entry_ids" : !Number.isFinite(r.total) ? "total" : null);
export const badVersion = (r) => (!r || typeof r !== "object" || typeof r.version !== "string" ? "version" : null);

const WHAT = { feeds: "a feed", articles: "an article", "entry numbers": "the list of entry numbers", version: "the version" };
export const plainProblem = (where, field) => `Miniflux sent ${WHAT[where] || where} without a usable "${field}".`;

// Collects the problems met during one refresh. Items that fail are counted and skipped, never guessed.
export function collector() {
  const seen = new Map(); let skipped = 0;
  return {
    note(where, field) { skipped++; const k = where + ":" + field; const p = seen.get(k); if (p) p.count++; else if (seen.size < 8) seen.set(k, { where, field, plain: plainProblem(where, field), count: 1 }); },
    get skipped() { return skipped; },
    done(srv, now) { srv.contract = { ok: skipped === 0, at: now, problems: [...seen.values()], skipped }; return srv; }
  };
}

// ---------- the lamp ----------
const since = (ms, now) => { const d = Math.max(0, now - ms); return d < 3600e3 ? "within the last hour" : d < 86400e3 ? `${Math.round(d / 3600e3)} hours ago` : `${Math.round(d / 86400e3)} days ago`; };
export function serverLamp(srv, configured, now = Date.now()) {
  const L = (state, sentence) => ({ id: "server", label: "Miniflux server", state, sentence });
  if (!configured) return L("off", "Not set up yet.");
  const c = srv.contract;
  if (c && c.ok === false) {
    const first = (c.problems || [])[0]; const n = c.skipped || 0;
    return L("red", `${first ? first.plain : "Miniflux answered in a shape Pravaha does not recognise."} ${n} item${n === 1 ? " was" : "s were"} left out of the last refresh so that nothing wrong was saved. Miniflux may have been updated; this version of Pravaha may need an update too.`);
  }
  if (srv.changed) {
    const ch = srv.changed;
    return L("amber", `Miniflux changed from ${ch.from} to ${ch.to} (${since(ch.at, now)}). Pravaha checked the answers it relies on and found nothing wrong. Look through your feeds, then press Got it.`);
  }
  if (!srv.checkedAt) return L("off", "Not checked yet. Pravaha checks on its next refresh.");
  const notes = [];
  if (srv.version && srv.caps.entryIds === false) notes.push(`This Miniflux is older than ${MIN_VERSION.entryIds}, so every refresh downloads all unread articles. It works, but updating Miniflux would make Pravaha lighter.`);
  else if (srv.caps.entryIds === false) notes.push("This server does not offer the list of entry numbers, so every refresh downloads all unread articles.");
  return L("green", srv.version ? `Miniflux ${srv.version}. The answers look as expected.${notes.length ? " " + notes.join(" ") : ""}` : `Working. This server did not report its version.${notes.length ? " " + notes.join(" ") : ""}`);
}
