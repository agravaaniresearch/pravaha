// Runs the real reader screen in an ordinary browser against the fake servers and synthetic data.
// Only used to take the README screenshots. Nothing here talks to a real service.
import { Engine, MemoryStorage } from "../../extension/src/engine.js";
import { makeHandlers } from "../../extension/src/handlers.js";
import { makeDav, makeMiniflux, makeRaindrop, router, feed, entry, settings } from "../../test/helpers.mjs";
const dav = makeDav(), mf = makeMiniflux(), rd = makeRaindrop({ bookmarks: [
  ...Array.from({ length: 24 }, (_, i) => ({ _id: i, title: `Frigate programme and shipyard capacity ${i}`, excerpt: "navy warship naval procurement shipbuilding", note: "", tags: ["defence", "shipbuilding"], link: `https://example.test/n${i}`, lastUpdate: new Date().toISOString() })),
  ...Array.from({ length: 12 }, (_, i) => ({ _id: 50 + i, title: `Radiotherapy planning and dose constraints ${i}`, excerpt: "oncology cancer treatment radiotherapy", note: "", tags: ["oncology"], link: `https://example.test/o${i}`, lastUpdate: new Date().toISOString() }))] });
mf.st.feeds = [feed(1, "Harbour Weekly", "Defence/Shipbuilding"), feed(2, "Clinic Notes", "Medicine"), feed(3, "Table Talk", "Food"), feed(4, "Ledger Daily", "Economy"), feed(5, "Old Blog", "Food", { parsing_error_count: 9 })];
const body = (t) => `<p>${t}</p><p>Officials said delivery schedules would depend on steel supply and on the readiness of the combat systems. Analysts noted that the contract sets a pattern for how future orders may be phased across several yards.</p><h2>What happens next</h2><p>The first review is expected next quarter, and a second round of trials will follow once the revised designs are approved by the committee.</p>`;
const items = [
  [1, 1, "Shipyard signs frigate contract for two more hulls", body("A shipyard on the east coast has signed a contract for two further frigates, with trials of the first hull completed last week."), 2, { reading_time: 5, tags: ["navy", "procurement"] }],
  [2, 2, "New trial of hypofractionated radiotherapy reports early results", body("A multicentre trial of shorter radiotherapy schedules reports comparable control with fewer visits for patients."), 3, { reading_time: 7, tags: ["oncology"] }],
  [3, 3, "Twelve weeknight pasta ideas", body("Dinner recipes for busy evenings, built around a handful of pantry staples and one good sauce."), 2, { reading_time: 4 }],
  [4, 1, "Port dredging tender opens for the naval harbour", body("A tender for dredging the naval harbour has opened, with bids due next month."), 6, { reading_time: 3, comments_url: "https://example.test/c/4" }],
  [5, 2, "Dose constraints for the oesophagus, revisited", body("A review of dose constraints for organs at risk argues for re-examining legacy thresholds."), 9, { reading_time: 9, tags: ["oncology", "review"] }],
  [6, 4, "Fiscal deficit widens as tax receipts fall short", body("Receipts fell short of the budget estimate for the third month running."), 5, { reading_time: 4 }],
  [7, 4, "Rupee steadies after a volatile week", body("The currency steadied as importers covered positions and the central bank stayed out of the market."), 8, { reading_time: 3 }],
  [8, 3, "A sourdough starter that survives neglect", body("A forgiving starter routine for people who forget to feed it."), 11, { reading_time: 6 }],
  [9, 1, "Submarine refit schedule slips by a quarter", body("A refit schedule has slipped by a quarter owing to a delay in spare parts."), 14, { reading_time: 5 }],
  [10, 2, "Imaging protocols and why they matter for AI tools", body("Standardising acquisition protocols is the quiet prerequisite for reliable imaging models."), 20, { reading_time: 8, enclosures: [{ url: "https://example.test/a.mp3", mime_type: "audio/mpeg" }] }],
  [11, 4, "What the latest trade data says about exports", body("Merchandise exports rose modestly while imports of electronics climbed faster."), 26, { reading_time: 4 }],
  [12, 5, "A post from a feed that keeps failing", body("This feed is failing in Miniflux and is excluded from ranking."), 30, {}]];
mf.st.entries = items.map(([id, f, t, c, h, x]) => { const e = entry(id, f, t, c, h, x); const fd = mf.st.feeds.find(q => q.id === f); e.feed = { id: f, title: fd.title, category: fd.category }; e.author = "Staff"; return e; });
const fetchImpl = router({ dav, mf, rd }); const storage = new MemoryStorage();
await storage.set({ settings: { ...settings("laptop"), webdav: { ...settings("laptop").webdav } } });
const listeners = [];
const engine = new Engine({ storage, fetchImpl, onChange: () => listeners.forEach(f => f({ type: "changed" })), platform: { echoDocs: async () => [{ title: "Navy frigate shipyard news", url: "https://example.test/x", visits: 6 }] } });
await engine.load(); await engine.syncNow(); await engine.openCard(2);
const handlers = makeHandlers({ engine, fetchImpl, runSync: () => engine.syncNow(), schedule: async () => {}, openTab: async () => {}, saveSynced: async () => {} });
mf.st.discover["https://harbourweekly.example"] = [{ url: "https://harbourweekly.example/feed.xml", title: "Harbour Weekly: all stories", type: "atom" }, { url: "https://harbourweekly.example/opinion.xml", title: "Harbour Weekly: opinion", type: "rss" }];
window.__engine = engine; window.__mf = mf;
window.browser = { runtime: { sendMessage: async (m) => handlers[m.type](m), onMessage: { addListener: (f) => listeners.push(f) } }, permissions: { request: async () => true, contains: async () => true } };
await import("../../extension/ui/reader.js");
document.body.dataset.ready = "1";
