// The toolbar popup, shown only on pages that announce feeds. It lists them and hands the choice to the reader's Add feed dialog.
import { h } from "./dom.js";
const app = document.getElementById("app");
const send = (m) => browser.runtime.sendMessage(m);
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
async function main() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const feeds = tab ? await send({ type: "feedsFor", tabId: tab.id }) : [];
  const go = async (url) => { await send({ type: "openSubscribe", url }); window.close(); };
  if (!feeds.length) { app.replaceChildren(h("h1", {}, "No feeds on this page"), h("p", { class: "sub" }, "Pravaha looks at the page's own feed links. You can still right-click a page or link and choose Subscribe with Pravaha."), h("button", { class: "open", "data-act": "open", onclick: () => { browser.tabs.create({ url: browser.runtime.getURL("ui/reader.html") }); window.close(); } }, "Open Pravaha")); return; }
  app.replaceChildren(
    h("p", { class: "eyebrow" }, "Subscribe with Pravaha"),
    h("h1", {}, feeds.length === 1 ? "This page has a feed" : `This page has ${feeds.length} feeds`),
    h("ul", {}, feeds.map(f => h("li", {}, h("div", { class: "what" }, h("b", {}, f.title || host(f.url)), h("span", {}, `${f.type.toUpperCase()} · ${host(f.url)}`)), h("button", { class: "sub-btn", "data-act": "subscribe", "aria-label": "Subscribe to " + (f.title || f.url), onclick: () => go(f.url) }, "Subscribe")))),
    h("button", { class: "open", "data-act": "open", onclick: () => { browser.tabs.create({ url: browser.runtime.getURL("ui/reader.html") }); window.close(); } }, "Open Pravaha instead"));
}
main();
