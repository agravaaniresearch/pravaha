# Roadmap

Pravaha stays a small reader. Every item below was weighed against one rule: a feature may add capability, but not complexity that compounds failure. Each item names what it costs in code and what could go wrong. Nothing here is promised; the order is a recommendation.

## Next: 0.9 (use what 0.8.0 measures)

1. **Collapse duplicate stories in the Ranked view.** 0.8.0 already finds stories covered by several feeds and knows which articles they are. The Ranked view can show one row with "and 3 more" that expands. About 40 lines in the reader; no new data. Risk: a wrong match hides an article, so the folded rows stay one click away.
2. **A calibration card on the Stats page.** For each score band, how often you opened or saved. If the top band is not opened more often than the bottom one, the ranking is not helping you, and the page says so in a sentence. Uses events already logged. About 30 lines.
3. **Triage mode on wide screens.** With the reading pane open, `j` and `k` move and open in the pane at once, marking the previous article read; `x` dismisses and moves on. This is the Inoreader-style keyboard flow at its fastest. About 30 lines; no new state.
4. **Let Miniflux save to Raindrop.** Miniflux has its own Raindrop integration (`POST /v1/entries/{id}/save` triggers it). Using it would take the Raindrop request off Firefox entirely. Cost: the locally suggested tags cannot travel with that call, so this would be a switch, not a replacement.
5. **History compaction.** The history log only grows (about 1 MB a year at normal use, plus about 0.7 MB a year of daily article counts). A yearly snapshot event that stands for everything older would keep the log, and each wake-up, small. This is the one item that touches the sync format, so it needs a version gate and its own failure trial before it ships.

## Then: 1.0 (ready to publish)

- Fresh AMO keys and a listed submission (the current keys are for testing).
- A first-run screen that tests all three connections in one go.
- Run the e2e suite against a real Miniflux on a throwaway account, once, and record the result in the README.
- The stemmer fix deferred from the mathematical review (`supply` and `supplies` should be one word), shipped with a migration of stored keyword rules.

## Later, if the need shows up

- **Learned weights.** Fit the five weights to your own opens and saves offline, from the history log, and propose them in Settings with a before-and-after on the calibration card. Deferred in the review because opens are biased by the ranking itself; it needs the calibration card first to be judged.
- **A Web Worker for scoring**, if your library grows past about 10,000 unread articles. Today scoring 3,000 takes about 50 ms.
- **A read-only MCP bridge outside the extension.** A tiny separate tool that reads the WebDAV files (digest, outbox, history) and answers a Grok or Claude bot. Keeping it outside means the extension never runs a server.
- **Storage per article.** Splitting the article copy into one key per article would make writes proportional to what changed. Only worth it if the deferred write ever shows up as a cost in Firefox's profiler.

## Considered and left out

- Scraping websites into feeds (dropped with FreshRSS; a separate tool can feed Miniflux).
- Paywall bypass and full-text fetching inside Firefox (Miniflux's own fetch is used).
- A read-later shelf and quiet hours (declined).
- Diversity re-ranking (the default view is grouped by feed, so it would only make the order disagree with the scores).
