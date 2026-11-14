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
