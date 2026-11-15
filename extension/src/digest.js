// Weekly markdown digest for the Obsidian folder. Front matter is Dataview-friendly.
export function isoWeek(ms) {
  const d = new Date(ms); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(); const w = Math.ceil((((t - Date.UTC(y, 0, 1)) / 86400000) + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
const esc = (s) => String(s || "").replace(/\|/g, "/").replace(/\[|\]/g, "");
export function buildDigest({ now, week, top, saved, authority, centroidTerms, previousTerms, trained }) {
  const lines = [
    "---", "type: pravaha-digest", `week: ${week}`, `generated: ${new Date(now).toISOString()}`,
    `saved: ${saved.length}`, `top: ${top.length}`, "---", "", `# Pravaha digest, ${week}`, "",
  ];
  for (const i of top) lines.push(`- ${Math.round(i.score * 100)} · [${esc(i.title)}](${i.url}) · ${esc(i.feedTitle)}${i.because ? " · " + esc(i.because) : ""}`);
  lines.push("", "## Saved this week", "");
  if (!saved.length) lines.push("- Nothing saved this week.");
  for (const i of saved) lines.push(`- [${esc(i.title)}](${i.url}) · ${esc(i.feedTitle)}${i.tags && i.tags.length ? " · " + i.tags.map(t => "#" + t.replace(/\s+/g, "-")).join(" ") : ""}`);
  lines.push("", "## Feeds earning attention", "");
  for (const a of authority.slice(0, 8)) lines.push(`- ${esc(a.title)}: ${Math.round(a.value * 100)}`);
  const t = trained || { more: [], less: [] };
  lines.push("", "## What you trained", "");
  if (!t.more.length && !t.less.length) lines.push("- No training yet. Use the thumbs on an article, or click its tags.");
  else { if (t.more.length) lines.push(`- More of: ${t.more.map(esc).join(", ")}`); if (t.less.length) lines.push(`- Less of: ${t.less.map(esc).join(", ")}`); }
  const rising = centroidTerms.filter(t => !(previousTerms || []).includes(t));
  lines.push("", "## Interest centroid", "", `Top terms: ${centroidTerms.join(", ")}`);
  if (previousTerms && previousTerms.length) lines.push("", `New since last digest: ${rising.length ? rising.join(", ") : "none"}`);
  return lines.join("\n") + "\n";
}
