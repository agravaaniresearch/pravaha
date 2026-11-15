// Pravaha feed detection. Registered only after the person turns on "Detect feeds on pages" and Firefox grants the permission.
// It reads one thing: the <link rel="alternate"> tags in the page head that announce an RSS, Atom or JSON feed. It sends the feed
// addresses to Pravaha's own background page and nothing else; the page text, forms and cookies are never read.
(() => {
  if (window.top !== window) return;
  const KIND = { "application/rss+xml": "rss", "application/atom+xml": "atom", "application/feed+json": "json", "application/json": "json" };
  const scan = () => {
    const out = [];
    for (const l of document.querySelectorAll("link[rel~='alternate'][href][type]")) {
      const kind = KIND[String(l.type).split(";")[0].trim().toLowerCase()]; if (!kind) continue;
      if (l.type.toLowerCase().startsWith("application/json") && !/feed|rss|atom/i.test(l.href)) continue;
      let url; try { url = new URL(l.getAttribute("href"), document.baseURI).href; } catch { continue; }
      if (!/^https?:/i.test(url) || out.some(f => f.url === url)) continue;
      out.push({ url, title: String(l.title || "").slice(0, 120), type: kind }); if (out.length >= 8) break;
    }
    return out;
  };
  let last = "";
  const report = () => { const feeds = scan(); const key = JSON.stringify(feeds); if (!feeds.length || key === last) return; last = key; try { browser.runtime.sendMessage({ type: "feedsFound", feeds }).catch(() => {}); } catch { /* the extension was reloaded */ } };
  report();
  // Some sites add the tag after the page loads. Watch the head briefly, then stop.
  if (document.head) { const mo = new MutationObserver(() => report()); mo.observe(document.head, { childList: true }); setTimeout(() => mo.disconnect(), 10000); }
})();
