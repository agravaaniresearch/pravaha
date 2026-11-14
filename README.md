# Pravaha

Pravaha is a Firefox extension that turns a hosted Miniflux server into a personal reader. It ranks your unread articles by how closely they match what you already save, read and act on. The name is Sanskrit for flow.

Miniflux keeps the feeds, read state, stars and folders. Pravaha adds a relevance engine, a reader screen, an event log that keeps two machines in step through Fastmail WebDAV, and optional one-way saving to Raindrop.

## What it does

- **Reads from Miniflux.** Folders are Miniflux categories. A slash makes a nested folder, so `Defence/Shipbuilding` appears as Shipbuilding inside Defence.
- **Ranks with four signals.** The score is 0.40 tag match, 0.30 sites you read, 0.20 feed standing and 0.10 freshness. Training rules add or subtract up to 0.2. Feeds you have not opened this session get a small novelty boost. All weights are editable in Settings.
- **Reads in place.** Opening an article shows it as a card inside the list, in Newsreader or Literata. Press `w` (the coffee cup) to ask Miniflux for the complete article. Press `b` to open it in a background tab. Both are logged, and a background open counts more than a card read.
- **Stays organised.** Feeds are collapsible sections with their Miniflux icon and an unread count. Marking a section read folds it away. Articles can be marked read as they scroll past the top. The tabs are Newsfeed, Saved, Stats, Sync and Settings.
- **Uses what Miniflux offers.** Thumbnails, reading time, word count, comment links, tags, audio and video enclosures and the full-article flag show as small chips.
- **Offers anchor bolding** (off by default): the first part of each word is bolded to give the eye a landing point. A strength control runs from lightest to strongest. It uses [text-vide](https://github.com/Gumball12/text-vide) (MIT, vendored in `extension/vendor`), an open implementation of the technique, and was inspired by the Open|Bionic project. It skips headings and code and works on Latin script only. Independent evidence that it speeds reading is weak, so treat it as a preference.
- **Has an OLED black theme** besides light and dark, and four reading controls: type, size, line gap and width.
- **Shows relevance as colour.** There are no Good, Great or Best tiers. Each row has a bar and a chip that darken as the score rises. Three palettes are included: ember, saffron and moss.
- **Learns from what you do.** Opening in a tab, reading a card, reading for more than 15 seconds, saving and dismissing all move a feed's standing. They fade with a 14 day half life. Opens and saves also pull your interest profile toward the article.
- **Trains like NewsBlur.** Open an article's details and choose More or Less for the feed, the author or a keyword.
- **Suggests tags locally.** Suggestions come from your own Raindrop tag vocabulary. No model and no network call is involved.
- **Syncs two machines safely.** Every action is an event in an append-only log. Each machine writes only its own files, so they cannot overwrite each other. Merging is a set union, so the order of arrival never changes the result.
- **Tells you the state in plain words.** Six status lights say what is working and what is left to sync.
- **Writes a weekly digest** to the WebDAV folder as Markdown with Dataview front matter, for Obsidian.
- **Accepts outside scores.** A Grok automation, or anything else, can write `enrich/results.json`. Pravaha blends 20 percent of that score with 80 percent of its own.

## Example run on synthetic data

Everything below is invented. The feeds, articles and bookmarks do not exist. The run uses the same fake servers as the test bed. Reproduce it with `node tools/example-run.mjs`.

```
Ranked on the laptop:
   33  Shipyard signs frigate contract  [Ranked for you]  fresh, a feed you have not opened this session
   28  New trial of hypofractionated radiotherapy  [Ranked for you]  fresh, a feed you have not opened this session
   17  Twelve weeknight pasta ideas  [Ranked for you]  fresh, a feed you have not opened this session
   15  Port dredging tender opens  [Ranked for you]  a feed you have not opened this session

Folder tree:
  Defence (2)
    Shipbuilding (2)
      Harbour Weekly (2)
  Food (2)
    Old Blog (1)
    Table Talk (1)
  Medicine (1)
    Clinic Notes (1)

After the laptop opens the oncology trial, dismisses the pasta story and trains Harbour Weekly up:
Ranked on the desktop (a second machine that never saw those clicks directly):
   42  Shipyard signs frigate contract  [Ranked for you]  fresh, boosted by your training, a feed you have not opened this session
   23  Port dredging tender opens  [Ranked for you]  boosted by your training, a feed you have not opened this session

Status lights on the desktop:
  green  Miniflux: Connected. Last fetch just now.
  green  WebDAV storage: Reachable. Last sync just now.
  green  Raindrop: Tags read just now.
  green  Reading history: Every change on this machine is on the storage.
  green  Other machines: laptop is up to date (last connected just now).
  red    Feeds: 1 feed is failing in Miniflux and excluded from ranking.
```

Reading it: the shipbuilding and radiotherapy stories lead because the invented Raindrop library is full of both. After the laptop trains Harbour Weekly up, the desktop ranks its stories higher without ever having seen the click directly. The pasta story is gone from the desktop because the laptop dismissed it. The desktop never cached the radiotherapy story because the laptop had already opened it before the desktop's first fetch. The Feeds light is red because the invented Old Blog feed is failing, and it is excluded from ranking.

## Install

See [DEPLOY.md](DEPLOY.md). The short version: download `pravaha.xpi` from the latest release, open `about:addons` in Firefox, click the gear icon and choose Install Add-on From File. Then open the extension's button, go to Settings and enter your Miniflux address and API key.

## Tests

```
npm install
npm test                       # 87 tests
node tools/failure-rates.mjs   # random failure injection, see docs/FAILURE_RATES.md
npm run lint                   # Mozilla's web-ext lint
```

The tests run in Node against in-memory fakes of Miniflux, WebDAV and Raindrop. They cover scoring, the event log, two-machine convergence, offline queues, corrupted files and the engine end to end. The reader screen itself is driven under jsdom against the real engine: opening cards, the sanitiser, collapsing, read on scroll, settings tests, themes and shortcuts. The jsdom run found one real bug, now fixed: Undo dismissed did not make the article unread again. The failure harness found and fixed one real bug: two overlapping Miniflux updates could drop a read. It is covered by a regression test.

## What has not been verified

- **Not run in a real Firefox.** The build has no Firefox binary. The code passes Mozilla's linter and the reader screen is tested under jsdom, but layout, fonts, scrolling and the browser APIs have not been exercised in a live browser. Read on scroll depends on Firefox's IntersectionObserver behaving as in the test.
- **Two Miniflux calls are untested against a real server.** Full-article fetch (`/entries/{id}/fetch-content`) and feed icons (`/feeds/{id}/icon`) follow the documented API and are tested against fakes only.
- **Not run against real servers.** The Miniflux, Fastmail WebDAV and Raindrop calls follow their documented APIs and are tested against fakes only. The Miniflux `changed_after` filter is the least certain of them.
- **Two machines can score slightly differently** until both hold the same Raindrop data, history snapshots and events. The order of articles is usually the same. Small differences in the number are expected.
- **No Web Worker yet.** Scoring runs on the main thread of the background page. It is fast at a few thousand articles. A worker is a later step if it is ever needed.
- **Keys stay on the machine by default.** Syncing them through Firefox Sync is an option, off by default. This departs from the Grok spec.

## Shortcuts

`j` and `k` move. `o` or Enter opens the card. `b` opens a background tab. `w` fetches the full article. `s` saves. `m` toggles read. `x` dismisses. `Shift+C` collapses or expands every feed. Esc closes the card.

## Layout

```
extension/          the add-on (manifest, background page, reader screen, modules in src/)
test/               node:test suites and the fake servers
tools/              failure-rate harness and the synthetic example
docs/               schema, policy review, failure rates
.github/workflows/  test, lint, sign and release
```

See [docs/SCHEMA.md](docs/SCHEMA.md), [docs/POLICY.md](docs/POLICY.md) and [docs/FAILURE_RATES.md](docs/FAILURE_RATES.md).

## Disclaimer

Pravaha is a personal reading tool provided as is, with no warranty. It ranks articles by similarity to your own habits. It does not judge whether an article is true, current or clinically sound, and a high score is not an endorsement. Do not use it as the basis for medical, legal or financial decisions. The example above contains only invented data. Keep your API keys private, use a Fastmail app password rather than your main password, and rotate any key that has been shared.

Licensed under Apache 2.0.
