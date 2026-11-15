// Turns raw sync facts into status lights with plain-prose sentences. No codes reach the screen.
export function ago(ms) {
  if (ms === null || ms === undefined) return "never";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"} ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? "" : "s"} ago`;
  return `${Math.round(s / 86400)} day${Math.round(s / 86400) === 1 ? "" : "s"} ago`;
}
const RANK = { off: 0, green: 1, amber: 2, red: 3 };
const worst = (states) => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "green");

export function computeStatus(i) {
  const since = (t) => (t ? ago(i.now - t) : "never");
  const lights = [];

  // Miniflux
  if (!i.miniflux.configured) lights.push({ id: "miniflux", label: "Miniflux", state: "off", sentence: "Not set up yet. Add the server address and API key in Settings." });
  else if (i.miniflux.error) lights.push({ id: "miniflux", label: "Miniflux", state: "red", sentence: `${i.miniflux.error.plain} Last success was ${since(i.miniflux.lastOkAt)}.` });
  else if (i.pendingOps > 0) lights.push({ id: "miniflux", label: "Miniflux", state: "amber", sentence: `${i.pendingOps} read or save change${i.pendingOps === 1 ? "" : "s"} still waiting to reach Miniflux.` });
  else lights.push({ id: "miniflux", label: "Miniflux", state: "green", sentence: `Connected. Last fetch ${since(i.miniflux.lastOkAt)}.` });

  // The Miniflux server itself: its version and whether its answers still look as expected
  if (i.serverLamp) lights.push(i.serverLamp);

  // WebDAV
  if (!i.webdav.configured) lights.push({ id: "webdav", label: "WebDAV storage", state: "off", sentence: "Not set up yet. Without it, dwell time and training stay on this machine only." });
  else if (i.webdav.error) lights.push({ id: "webdav", label: "WebDAV storage", state: "red", sentence: `${i.webdav.error.plain} Last successful sync was ${since(i.webdav.lastOkAt)}.` });
  else lights.push({ id: "webdav", label: "WebDAV storage", state: "green", sentence: `Reachable. Last sync ${since(i.webdav.lastOkAt)}.` });

  // Raindrop
  if (!i.raindrop.configured) lights.push({ id: "raindrop", label: "Raindrop", state: "off", sentence: "Not set up yet. Tag matching will use only your bookmarks and history." });
  else if (i.raindrop.error) lights.push({ id: "raindrop", label: "Raindrop", state: "amber", sentence: `${i.raindrop.error.plain} Tags were last read ${since(i.raindrop.lastOkAt)}.` });
  else lights.push({ id: "raindrop", label: "Raindrop", state: "green", sentence: `Tags read ${since(i.raindrop.lastOkAt)}.` });

  // Event log on this machine
  if (!i.webdav.configured) lights.push({ id: "log", label: "Reading history", state: "off", sentence: `${i.pendingEvents} event${i.pendingEvents === 1 ? "" : "s"} kept on this machine.` });
  else if (i.pendingEvents > 0) lights.push({ id: "log", label: "Reading history", state: i.webdav.error ? "red" : "amber", sentence: `${i.pendingEvents} change${i.pendingEvents === 1 ? "" : "s"} on this machine ${i.webdav.error ? "cannot reach" : "not yet on"} the storage. They are safe here and will be sent when the storage answers.` });
  else if (i.corruptLines > 0) lights.push({ id: "log", label: "Reading history", state: "amber", sentence: `Everything is synced, but ${i.corruptLines} damaged line${i.corruptLines === 1 ? "" : "s"} in another machine's log ${i.corruptLines === 1 ? "was" : "were"} skipped.` });
  else lights.push({ id: "log", label: "Reading history", state: "green", sentence: "Every change on this machine is on the storage." });

  // Other machines
  const others = Object.entries(i.others || {});
  const machines = [];
  if (!i.webdav.configured) lights.push({ id: "machines", label: "Other machines", state: "off", sentence: "Needs the WebDAV storage." });
  else if (!others.length) lights.push({ id: "machines", label: "Other machines", state: "off", sentence: "No other machine has connected yet." });
  else {
    let st = "green"; const sentences = [];
    for (const [dev, s] of others) {
      const theyHaveMine = !i.myHead || (s.appliedHeads && s.appliedHeads[i.device] && s.appliedHeads[i.device] >= i.myHead);
      const iHaveTheirs = !s.head || (i.remoteHeads[dev] && i.remoteHeads[dev] >= s.head);
      const leftAt = since(s.updatedAt);
      if (!iHaveTheirs) { st = "amber"; sentences.push(`${dev} has changes this machine has not read yet.`); machines.push({ device: dev, pendingHere: true }); }
      else if (!theyHaveMine) { st = "amber"; sentences.push(`${dev} has not yet received your latest changes. It last connected ${leftAt}, and will catch up when it next opens.`); machines.push({ device: dev, pendingThere: true }); }
      else sentences.push(`${dev} is up to date (last connected ${leftAt}).`);
    }
    lights.push({ id: "machines", label: "Other machines", state: st, sentence: sentences.join(" ") });
  }
  // One entry per machine for the dashboard: this machine first, then the others as the storage last described them.
  const counts = i.eventCounts || {};
  const devices = [{ device: i.device, me: true, events: counts[i.device] || 0, lastSeenAt: null, state: i.pendingEvents > 0 ? "amber" : "green" }];
  for (const [dev, s] of others) {
    const theyHaveMine = !i.myHead || (s.appliedHeads && s.appliedHeads[i.device] && s.appliedHeads[i.device] >= i.myHead);
    const iHaveTheirs = !s.head || (i.remoteHeads[dev] && i.remoteHeads[dev] >= s.head);
    devices.push({ device: dev, me: false, events: counts[dev] || 0, lastSeenAt: s.updatedAt || null, state: iHaveTheirs && theyHaveMine ? "green" : "amber", behind: !theyHaveMine, ahead: !iHaveTheirs });
  }

  // Feed health
  if (i.feeds && i.feeds.total) {
    const { dead, trouble } = i.feeds;
    if (dead) lights.push({ id: "feeds", label: "Feeds", state: "red", sentence: `${dead} feed${dead === 1 ? " is" : "s are"} failing in Miniflux and excluded from ranking.${trouble ? ` ${trouble} more had trouble.` : ""}` });
    else if (trouble) lights.push({ id: "feeds", label: "Feeds", state: "amber", sentence: `${trouble} feed${trouble === 1 ? " has" : "s have"} had trouble in Miniflux.` });
    else lights.push({ id: "feeds", label: "Feeds", state: "green", sentence: `All ${i.feeds.total} feeds fetching normally.` });
  }

  // Green means something is connected and healthy. With nothing set up the answer is "off", never "in sync".
  const syncLights = lights.filter(l => ["miniflux", "server", "webdav", "log", "machines"].includes(l.id) && l.state !== "off");
  const overall = !i.miniflux.configured ? "off" : worst(syncLights.map(l => l.state));
  const scope = !i.miniflux.configured ? "none" : i.webdav.configured ? "full" : "miniflux";
  return {
    overall, scope, lights, devices,
    left: { events: i.pendingEvents, ops: i.pendingOps, machines }
  };
}
