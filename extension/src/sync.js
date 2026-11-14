// Sync of the event log over WebDAV. Each machine writes only its own segments, so two machines
// can never overwrite each other. Pending events stay in the local outbox until a push succeeds.
import { SEGMENT_SIZE, segmentName, toSegmentText, parseSegment } from "./eventlog.js";
import { PlainError } from "./webdav.js";

export function freshSyncState() {
  return { pushedSeq: 0, applied: {}, remoteHeads: {}, lastPushOk: null, lastPullOk: null, lastError: null, corruptLines: 0, leaseHeld: false };
}

export class Syncer {
  constructor({ dav, log, device, root = "pravaha", now = () => Date.now(), state, localExtra = () => ({}) }) {
    this.dav = dav; this.log = log; this.device = device; this.root = root; this.now = now;
    this.state = state || freshSyncState(); this.localExtra = localExtra; this._dirs = false;
  }
  pending() { return this.log.own().filter(e => Number(e.eid.split(":")[1]) > this.state.pushedSeq); }

  async ensureDirs() {
    if (this._dirs) return;
    await this.dav.mkdirs(`${this.root}/events/${this.device}`);
    await this.dav.mkdirs(`${this.root}/state`);
    await this.dav.mkdirs(`${this.root}/digests`);
    await this.dav.mkdirs(`${this.root}/enrich`);
    this._dirs = true;
  }

  async pull() {
    const devices = (await this.dav.list(`${this.root}/events`)).filter(d => d !== this.device);
    let pulled = 0;
    for (const dev of devices) {
      const segs = (await this.dav.list(`${this.root}/events/${dev}`)).filter(n => /^\d{4}\.jsonl$/.test(n)).sort();
      const applied = (this.state.applied[dev] ||= {});
      for (const seg of segs) {
        if (applied[seg] >= SEGMENT_SIZE) continue;
        const text = await this.dav.get(`${this.root}/events/${dev}/${seg}`);
        if (text === null) continue;
        const { events, corrupt } = parseSegment(text);
        if (corrupt) this.state.corruptLines += corrupt;
        pulled += this.log.merge(events);
        applied[seg] = events.length;
      }
      this.state.remoteHeads[dev] = this.log.headOf(dev);
    }
    this.state.lastPullOk = this.now();
    return { pulled, devices };
  }

  async push() {
    const pend = this.pending();
    if (!pend.length) { this.state.lastPushOk = this.now(); return 0; }
    const own = this.log.own();
    const segs = [...new Set(pend.map(e => Math.floor((Number(e.eid.split(":")[1]) - 1) / SEGMENT_SIZE)))].sort((a, b) => a - b);
    let pushed = 0;
    for (const s of segs) {
      const inSeg = own.filter(e => Math.floor((Number(e.eid.split(":")[1]) - 1) / SEGMENT_SIZE) === s);
      await this.dav.put(`${this.root}/events/${this.device}/${segmentName(s)}`, toSegmentText(inSeg));
      const maxSeq = Number(inSeg[inSeg.length - 1].eid.split(":")[1]);
      pushed += inSeg.filter(e => Number(e.eid.split(":")[1]) > this.state.pushedSeq).length;
      this.state.pushedSeq = Math.max(this.state.pushedSeq, maxSeq);
    }
    this.state.lastPushOk = this.now();
    return pushed;
  }

  async writeState(extra = {}) {
    const appliedHeads = {}; for (const d of Object.keys(this.state.remoteHeads)) appliedHeads[d] = this.state.remoteHeads[d];
    const body = { device: this.device, updatedAt: this.now(), head: this.log.headOf(this.device), pushedSeq: this.state.pushedSeq, appliedHeads, ...this.localExtra(), ...extra };
    await this.dav.put(`${this.root}/state/${this.device}.json`, JSON.stringify(body));
  }

  async readOtherStates() {
    const names = (await this.dav.list(`${this.root}/state`)).filter(n => n.endsWith(".json") && n !== `${this.device}.json`);
    const out = {};
    for (const n of names) {
      try { const t = await this.dav.get(`${this.root}/state/${n}`); if (t) out[n.replace(/\.json$/, "")] = JSON.parse(t); } catch { /* a damaged state file is ignored; its events still merge */ }
    }
    return out;
  }

  async takeLease() { await this.dav.put(`${this.root}/lease.json`, JSON.stringify({ device: this.device, since: this.now(), heartbeat: this.now() })); this.state.leaseHeld = true; }
  async releaseLease() { await this.dav.put(`${this.root}/lease.json`, JSON.stringify({ device: null, since: null, heartbeat: this.now(), releasedBy: this.device })); this.state.leaseHeld = false; }
  async readLease() { try { const t = await this.dav.get(`${this.root}/lease.json`); return t ? JSON.parse(t) : null; } catch { return null; } }

  // One full pass: pull, push, publish this machine's state. Never throws; the outcome is in the report.
  async sync() {
    const report = { ok: false, pulled: 0, pushed: 0, pending: this.pending().length, others: {}, error: null };
    try {
      await this.ensureDirs();
      const p = await this.pull(); report.pulled = p.pulled;
      report.pushed = await this.push();
      await this.writeState();
      report.others = await this.readOtherStates();
      report.pending = this.pending().length;
      report.ok = true; this.state.lastError = null;
    } catch (e) {
      const plain = e instanceof PlainError ? e.plain : "Sync stopped because of an unexpected problem. The changes are still saved on this machine and will be retried.";
      this.state.lastError = { plain, at: this.now(), code: e.code || "error" };
      report.error = this.state.lastError; report.pending = this.pending().length;
    }
    return report;
  }
}
