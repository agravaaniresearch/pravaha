// A settings file: the same things Firefox Sync carries, plus optionally the reading history, in one JSON file.
// Keys (Miniflux, WebDAV and Raindrop) are never written in the clear: they are sealed with a passphrase using
// PBKDF2 (SHA-256, 250,000 rounds) and AES-GCM. Without a passphrase the file simply leaves the keys out.
import { PlainError } from "./webdav.js";
import { partData, patchFor, hasKeys, PARTS } from "./profilesync.js";

export const FORMAT = "pravaha-settings";
export const VERSION = 1;
const ITER = 250000;

const b64 = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (t) => Uint8Array.from(atob(t), c => c.charCodeAt(0));

async function keyFrom(passphrase, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(obj, passphrase, iter = ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(passphrase, salt, iter), new TextEncoder().encode(JSON.stringify(obj)));
  return { kdf: "PBKDF2-SHA256", iter, cipher: "AES-256-GCM", salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(ct)) };
}
export async function open(sealed, passphrase) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, await keyFrom(passphrase, unb64(sealed.salt), sealed.iter), unb64(sealed.data));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { throw new PlainError("That passphrase did not open the keys in this file. Check it and try again.", "bad-passphrase"); }
}

// options: { keys: bool, passphrase, history: bool, ui }
export async function exportBundle(engine, { keys = false, passphrase = "", history = false, ui = null } = {}) {
  const s = engine.settings;
  if (keys && !String(passphrase).length) throw new PlainError("Choose a passphrase to protect the keys, or leave the keys out of the file.", "need-passphrase");
  const out = { format: FORMAT, version: VERSION, exportedAt: new Date(engine.now()).toISOString(), from: s.device, settings: partData(s, "settings"), order: partData(s, "order"), ui: ui || partData(s, "ui") };
  out.keys = keys && hasKeys(s) ? await seal(partData(s, "keys"), passphrase) : null;
  if (history) out.events = engine.log.list();
  return out;
}

// Reads a file's text and applies it. Returns what was applied, so the screen can say it in words.
export async function importBundle(engine, text, { passphrase = "" } = {}) {
  let o; try { o = JSON.parse(text); } catch { throw new PlainError("That file is not a Pravaha settings file (it is not valid JSON).", "bad-file"); }
  if (!o || o.format !== FORMAT) throw new PlainError("That file is not a Pravaha settings file.", "bad-file");
  if (Number(o.version) > VERSION) throw new PlainError("That file was made by a newer Pravaha. Update this machine first.", "newer-file");
  const applied = []; const patches = [];
  if (o.keys) {
    if (!String(passphrase).length) throw new PlainError("This file contains keys. Enter its passphrase to bring them in.", "need-passphrase");
    patches.push(["keys", patchFor("keys", await open(o.keys, passphrase))]);
  }
  patches.push(["settings", patchFor("settings", o.settings)], ["order", patchFor("order", o.order)], ["ui", patchFor("ui", o.ui)]);
  for (const [part, patch] of patches) if (patch) { await engine.saveSettings(patch); applied.push(part); }
  let events = 0;
  if (Array.isArray(o.events) && o.events.length) { events = engine.log.merge(o.events); engine._invalidate(); await engine.persist(["events"]); if (events) applied.push("history"); }
  return { applied, events, from: o.from || null, exportedAt: o.exportedAt || null, hadKeys: !!o.keys };
}
export { PARTS };
