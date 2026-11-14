// Counts the time an opened article's tab is actually in front of you.
export class DwellTracker {
  constructor() { this.tabs = new Map(); this.active = null; this.since = null; }
  flush(now) {
    if (this.active !== null && this.tabs.has(this.active) && this.since !== null) this.tabs.get(this.active).ms += Math.max(0, now - this.since);
    this.since = this.active !== null ? now : null;
  }
  track(tabId, meta, now, isActive = false) {
    this.tabs.set(tabId, { meta, ms: 0 });
    if (isActive) this.setActive(tabId, now);
  }
  setActive(tabId, now) { this.flush(now); this.active = this.tabs.has(tabId) ? tabId : null; this.since = this.active !== null ? now : null; }
  blur(now) { this.flush(now); this.active = null; this.since = null; }
  snapshot() { return { tabs: [...this.tabs.entries()], active: this.active, since: this.since }; }
  restore(o) { if (!o) return; this.tabs = new Map(o.tabs || []); this.active = o.active ?? null; this.since = o.since ?? null; }
  close(tabId, now) {
    if (!this.tabs.has(tabId)) return null;
    if (this.active === tabId) this.flush(now);
    const r = this.tabs.get(tabId); this.tabs.delete(tabId);
    if (this.active === tabId) { this.active = null; this.since = null; }
    return r;
  }
}
