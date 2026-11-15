// Synthetic-data example run. Everything here is invented; no real feeds, keys or people.
import { Engine, MemoryStorage } from "../extension/src/engine.js";
import { makeDav, makeMiniflux, makeRaindrop, router, feed, entry, settings } from "../test/helpers.mjs";
const dav = makeDav(), mf = makeMiniflux(), rd = makeRaindrop({ bookmarks: [
  ...Array.from({ length: 22 }, (_, i) => ({ _id: i, title: `Frigate programme and shipyard capacity ${i}`, excerpt: "navy warship naval procurement", note: "", tags: ["defence", "shipbuilding"], link: `https://example.org/n${i}`, lastUpdate: new Date().toISOString() })),
  ...Array.from({ length: 8 }, (_, i) => ({ _id: 50 + i, title: `Radiotherapy planning and dose constraints ${i}`, excerpt: "oncology cancer treatment", note: "", tags: ["oncology"], link: `https://example.org/o${i}`, lastUpdate: new Date().toISOString() }))] });
mf.st.feeds = [feed(1, "Harbour Weekly", "Defence/Shipbuilding"), feed(2, "Clinic Notes", "Medicine"), feed(3, "Table Talk", "Food"), feed(4, "Old Blog", "Food", { parsing_error_count: 8 })];
const items = [[1, 1, "Shipyard signs frigate contract", "Navy procurement of new warship frigates moves ahead.", 4], [2, 2, "New trial of hypofractionated radiotherapy", "Oncology trial reports cancer treatment dose results.", 6],
  [3, 3, "Twelve weeknight pasta ideas", "Dinner recipes for busy evenings.", 2], [4, 1, "Port dredging tender opens", "Harbour dredging tender for naval port.", 20], [5, 4, "Dead feed story about frigates", "naval shipyard", 3]];
for (const [id, f, t, c, h] of items) { const e = entry(id, f, t, c, h); const fd = mf.st.feeds.find(x => x.id === f); e.feed = { id: f, title: fd.title, category: fd.category }; mf.st.entries.push(e); }
const mkEngine = async (name) => { const s = new MemoryStorage(); await s.set({ settings: settings(name) }); const e = new Engine({ storage: s, fetchImpl: router({ dav, mf, rd }) }); await e.load(); return e; };
const A = await mkEngine("laptop"), B = await mkEngine("desktop");
const show = (title, v) => { console.log(title); for (const g of v.groups) for (const r of g.rows) console.log(`  ${String(Math.round(r.score * 100)).padStart(3)}  ${r.title}  [${g.title}]  ${r.why}`); };
await A.syncNow(); show("Ranked on the laptop:", A.getView({ ranked: true }));
console.log("\nFolder tree:"); for (const n of A.tree()) console.log("  " + "  ".repeat(n.depth) + n.label + (n.unread ? ` (${n.unread})` : ""));
await A.open(2); await A.dismiss(3); await A.train("feed", 1, 1); await A.syncNow(); await B.syncNow(); await A.syncNow();
console.log("\nAfter the laptop opens the oncology trial, dismisses the pasta story and trains Harbour Weekly up:");
show("Ranked on the desktop (a second machine that never saw those clicks directly):", B.getView({ ranked: true, mode: "all" }));
console.log("\nStatus lights on the desktop:"); for (const l of B.status().lights) console.log(`  ${l.state.padEnd(6)} ${l.label}: ${l.sentence}`);

// ---- 0.6.0: light refresh, feed management, server check ----
console.log("\nSecond refresh on the laptop (nothing new):");
await A.syncNow(); const nm = A.net.miniflux; console.log(`  ${nm.mode} refresh, ${nm.calls} requests, ${nm.bytes} bytes`);
const e9 = entry(9, 3, "Quick sourdough starter guide", "Baking.", 1); e9.feed = { id: 3, title: "Table Talk", category: { title: "Food" } }; mf.st.entries.push(e9);
await A.syncNow(); console.log(`After one new article: ${A.net.miniflux.mode} refresh, ${A.net.miniflux.calls} requests, ${A.net.miniflux.bytes} bytes`);
console.log("\nFeed management:");
console.log("  " + (await A.feedUpdate(3, { title: "Table Talk Weekly" })).sentence);
console.log("  " + (await A.feedUpdate(3, { category: "Food/Baking" })).sentence);
console.log("  " + (await A.feedUpdate(3, { disabled: true })).sentence);
console.log("  " + (await A.folderRename("Defence", "Maritime")).sentence);
console.log("  " + (await A.feedDelete(4, "wrong name")).sentence);
console.log("\nCheck server (read-only):"); for (const l of (await A.serverCheck()).lines) console.log(`  ${l.state.padEnd(6)} ${l.text}`);
console.log("\nFolder tree now:"); for (const n of A.tree()) console.log("  " + "  ".repeat(n.depth) + n.label + (n.unread ? ` (${n.unread})` : ""));

// ---- 0.7.0: thumbs, clickable tags, Raindrop context ----
console.log("\n--- 0.7.0: training in plain sight ---");
rd.st.bookmarks.push({ _id: 900, title: "Shipyard signs frigate contract", excerpt: "frigate shipyard navy contract", note: "Compare with last year's tender", tags: ["defence", "to-read"], link: "https://www.site1.example/1/?utm_source=newsletter#top", lastUpdate: "2026-03-12T00:00:00Z" });
await A.refreshRaindrop(true);
const show1 = (t) => { console.log(`  tags:  ${t.tags.map(x => `${x.tag}${x.source === "raindrop" ? " (your Raindrop tag)" : ""}${x.value ? " [" + (x.value > 0 ? "more" : "less") + "]" : ""}`).join(", ") || "none"}`); console.log(`  words: ${t.words.map(x => x.word + (x.value ? " [" + (x.value > 0 ? "more" : "less") + "]" : "")).join(", ")}`); };
let t1 = A.trainerFor(1); console.log("The card for “Shipyard signs frigate contract”:"); show1(t1);
const rdx = t1.raindrop.exact; console.log(`  Raindrop: you saved this page (${rdx.tags.map(x => "#" + x).join(" ")}) with the note “${rdx.note}”`);
console.log("  Close to something you saved: " + (t1.raindrop.related.map(x => `“${x.title}” (sim ${x.sim})`).join("; ") || "nothing close enough (a save is offered only above a similarity of 0.22)"));
const before = A.scoreRow(1).score; const up = await A.rateStory(1, 1);
console.log(`\nThumbs up: score ${Math.round(before * 100)} -> ${Math.round(up.score * 100)}; trained ${up.labels.join(", ")}`);
await A.train("tag", "to-read", -1); console.log(`Click the “to-read” tag so it is “less”: score ${Math.round(up.score * 100)} -> ${Math.round(A.scoreRow(1).score * 100)}`);
await A.rateStory(1, 0); console.log(`Take the thumb back: score ${Math.round(A.scoreRow(1).score * 100)}; the hand-set “to-read: less” rule is kept: ${A.trainingRules().map(r => `${r.type}:${r.key}:${r.value}`).join(", ")}`);
await A.rateStory(2, -1); await A.syncNow(); await B.syncNow();
console.log(`The desktop, which never saw the clicks, holds the same rules: ${B.trainingRules().map(r => `${r.type}:${r.key}:${r.value}`).sort().join(", ")}`);
const dg = await A.writeDigest(); console.log("\nThe digest now carries:\n" + dg.md.split("\n").filter(l => /What you trained|More of|Less of|saved in Raindrop/.test(l)).map(l => "  " + l).join("\n"));
