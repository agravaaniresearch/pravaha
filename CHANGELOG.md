# Changelog

## 0.8.7

- **Fresher articles when you look, in the spirit of Inoreader.** When you open the reader or press Sync now, Pravaha asks Miniflux to fetch every feed at once, then looks again 45 seconds and 2 minutes later to bring in what arrived. Quiet background polls never ask.
- It asks at most once every 15 minutes. If Miniflux refuses or limits the request, Pravaha does not ask again for an hour, and syncing carries on unaffected.
- A setting under Connections turns it off ("Ask Miniflux to fetch every feed when I open the reader or press Sync now").
- Limits: hosted Miniflux still decides how fast it fetches each feed after being asked, and how often it accepts the request has not been tested against the real service. Checked: 272 tests pass (3 new) and lint is clean.

## 0.8.6

- **Read changes are sent to Miniflux in batches.** Opening a card, marking read or unread, dismissing, and reading on scroll now change the screen and are saved on this machine at once, but reach Miniflux together in one request. The batch goes 30 seconds after your last change, when you leave the Newsfeed or Saved tab, when the reader tab is hidden or closed, at every poll, on Sync now, and when Firefox unloads the background page. Forty articles read on scroll now cost one request instead of forty.
- **Still sent at once:** saves and unsaves (which also carry any held reads with them), a large "mark as read" that Pravaha checks with Miniflux, subscribing, and feed changes.
- Nothing is lost if Firefox closes before a batch goes: the changes are on disk and are sent at the next start. The one cost is that, until then, your other machine still shows those articles as unread.
- The status pill says "Saved here, N held for Miniflux" while a batch is waiting, instead of a spinning "Sending" light, and the Miniflux tile stays green.
- Checked: 269 tests pass (4 new), lint is clean, and in real Firefox 160 three cards opened in a row sent no request until the Newsfeed was left, then one.

## 0.8.2

- **Fixed: 0.8.1 could not reach Miniflux, WebDAV or Raindrop from the background.** 0.8.1 added a request counter for the health tile that called a fetch function the background page never passes, so every sync request failed while the Test buttons (which run in the reader tab) still worked. The counter now falls back to the browser's own fetch. A test builds the engine exactly as the background does, and real Firefox 160 reaches the fake servers again.
- **Fixed: too many large writes while reading.** The health tile was right: each article you read rewrote the article copy (about a megabyte) 1.2 seconds later, about 20 MB an hour during heavy reading. The large keys now wait a minute and are written at the next poll or when Firefox unloads the page, so a reading burst costs one write. Your changes stay safe meanwhile, because the queue for Miniflux and the newest history lines are still written at once.
- The health tile no longer turns amber when a poll writes changes that your own reading left waiting.
- The one-time switch-off of Pravaha's own Raindrop save is now saved to disk at once.

## 0.8.1

- **Training rules are tidy.** On the Stats page the rules now sit in one collapsed line that gives the count ("24 rules: 18 more, 6 less"). Opened, they are grouped into More and Less as small chips, each with an × to remove it, and a filter box appears once there are more than twelve.
- **Miniflux's Raindrop saves count for ranking.** Pravaha finds the Raindrop collection named "MiniFlux Saves" (matched by title, nested or not). An article in it that Pravaha also holds counts as a save: it pulls the interest profile and raises its feed's standing. Nothing is written to the history for it, so nothing new travels between machines, and an article you also saved in Pravaha counts once. The Raindrop tile on the Sync page names the collection and how many of its saves matched.
- **Pravaha's own save to Raindrop is off.** Miniflux now does that job, so the update switches Pravaha's one-way save off once, to avoid duplicates. It can be turned back on in Settings.
- **Extension health.** The Sync page has an Extension health tile, and the status pill in the top bar carries a small dot of the same colour. It shows what Pravaha itself costs: bytes written to Firefox's storage in the last hour, how many large writes there were, the last poll's time, requests and bytes, model rebuilds, the size of the history, and the total stored. It turns amber past 1 MB written in an hour, or if a poll that found nothing new rewrote the article copy or history; it turns red past 10 MB in an hour. A line shows the bytes written by each of the last 30 polls.
- Checked: 263 tests pass, lint is clean, the failure trials are unchanged, and the new rules panel, health tile and dot render in real Firefox 160 without console errors. The "MiniFlux Saves" signal is tested against fakes only.

## 0.8.0

A senior review of the whole code base, a mathematical review of the relevance engine, and a pass for lightness and design. No event type was added and no stored key was renamed, so 0.7.0 and 0.8.0 machines read each other's history; update both machines anyway, because only 0.8.0 understands the daily article counts that the new feed standing uses.

### Lighter

Measured with `node tools/bench-lightness.mjs` on a synthetic library (200 feeds, 3,000 unread articles, 4,400 Raindrop saves, 2,000 history events) in headless Node against the fakes. The numbers show the size of the change, not the speed of your machine.

| What | 0.7.0 | 0.8.0 |
|---|---|---|
| Written to Firefox's storage on an idle poll | 6.6 MB | about 1 KB |
| Written at once when you open a card | 3.3 MB | about 1 KB (the article copy follows once, 1.2 s after a burst of actions) |
| Requests on an idle poll after Firefox wakes the extension | 19 | 5 |
| Requests on an idle poll while awake | 10 | 3 |
| Time for an idle poll after a wake | 661 ms | 82 ms |
| Opening a card and redrawing the list | 336 ms | 77 ms |
| Polls while no Pravaha tab is open | every 2 minutes | at most every 10 minutes |

Causes removed:

- Every poll and every action rewrote the whole article copy, history log and search index. Now the small keys are written at once, the heavy ones a moment later and only when their content changed, and this machine's newest history lines go out at once as a short tail so nothing is lost if Firefox closes in between.
- Every open, card, save or dismiss rebuilt the vocabulary and all 4,400 bookmark vectors. They are now built once per Raindrop copy; only the interest profile is recomputed.
- Every poll re-read the whole feed list, downloaded the full text of every article whose state changed, made the WebDAV folders again after each wake, rewrote this machine's state file, downloaded the other machine's newest history file and uploaded the outside-scoring file. Now: the feed list every fifteen minutes (or at once when an unknown feed appears), no bodies on a light refresh, folders once, the state file when it changed or every fifteen minutes, the other machine's history only when its state file says there is something new, and the outside-scoring files at most hourly.
- A feed icon Miniflux refused was asked for again on every poll.
- Article vectors were thrown away on every refresh and rebuilt.

### Fixed

- **A server that never answered froze syncing until Firefox restarted.** No request had a deadline, and the sync lock stayed taken. Every request to Miniflux, WebDAV and Raindrop now gives up after 30 seconds (60 for WebDAV, 90 for the full-article fetch) with a plain sentence, and the lock has a second guard.
- **CI could not build 0.7.0.** A test read the git-ignored fonts folder, which does not exist in a clean checkout, so no signed release was made. The test now accepts a build without the fonts.
- A clock far ahead on another machine was adopted and froze decay for everyone. More than a day ahead is now ignored.
- A damaged training value could zero every matching article. It is now skipped, and values are kept within -3 to 3.
- A theme or folder-order change rebuilt the Miniflux, WebDAV and Raindrop clients and threw away the model. Only a change of connection or machine name does now.
- Raindrop's rate limit (429) is explained in plain words.

### Ranking (see docs/RELEVANCE_REVIEW.md)

An independent mathematical review found four structural problems. Each is fixed:

- **Feed standing is now the share of a feed's articles you engage with, not how many.** In 0.7.0 a feed with 100 articles a day and 2 opened scored the same as a feed you read in full (both 1.0), and a busy month kept a feed at the top for about two months. Standing is now an engagement rate with a prior, shown so that an average feed sits at 0.5. Once a day each machine logs how many articles each feed published (a `calibration` event; earlier versions already accept and ignore it).
- **Tag match now uses your best-matching Raindrop tag**, not one average of every bookmark, which sat between your interests and barely separated a minority interest from off-topic articles. The reason line names the tag.
- **The interest profile no longer forgets your bookmarks.** Opens, saves and thumbs can now take at most 30 percent of it and fade over 60 days; in 0.7.0 a hundred opens left the bookmarks 0.6 percent of the profile.
- **One open is counted once.** Pages opened from Pravaha are left out of the browsing-history signal.
- **Hot stories (Fever-style).** The same story carried by several of your feeds within 36 hours gets a "3 feeds" chip and a small boost (new weight "Covered by several feeds", 10 percent by default).
- Undo of a save or a dismiss is exact. A signal with nothing behind it hands its weight to the others instead of capping every score. "F-35", "S-400" and "MQ-9B" survive as words, HTML entities no longer become words, and "U.S." is kept.
- The colour stretch no longer clips, so the top of the list stays distinguishable. Scores are higher on the whole than in 0.7.0, so colours look warmer.

On the synthetic library the share of on-topic articles in the top 100 went from 87 to 100. That library has cleanly separated interests, so expect a smaller gain on yours; the Stats page shows it.

### Design

- **A reading pane on wide screens.** At 1800 pixels and wider, the open article reads in its own pane on the right while the list stays on the left; with nothing open the pane says how to open one. Below that width nothing changes.
- **Three new themes, each with its own relevance colours:** Khadi (unbleached cotton, kohl text, sindoor accent), Jamun (plum dark with kesar saffron running into rani pink), Lacquer (oxblood dark with jade). Choosing one also picks its colours; the palette can still be changed.
- The open row no longer repeats the title and summary above the card. Scores sit at the right edge in tabular figures, and the relevance strip glows faintly in its own colour so the day's heat reads down the left edge.

### Found by the independent QA pass in real Firefox 160, and fixed

- Reordering folders wrote the history copy of the order in memory only, so it was lost when Firefox unloaded the background page (Firefox Sync still carried it). It is now saved at once; checked by unloading the page in real Firefox.
- With the side pane open, Page Down, Space and the arrow keys scrolled the list behind it. They now scroll the article.
- A publish date in the future showed as "1 minute ago" with a New chip and sat first in its feed. The display and the order now use the same guard as the score.
- Leaving Khadi, Jamun or Lacquer kept their relevance colours on the other themes.
- The hot chip on Khadi was 4.0:1 contrast; it is now above 4.5:1. "Why it ranks here" lacked a bar for the fifth signal.
- Each wake of the background page re-armed the poll alarm, adding an extra poll twelve seconds later (present since 0.4). The alarm is now re-armed only when the interval changes.
- Pressing Sync now while a quiet poll was running returned at once and did nothing. It now runs right after.
- WebDAV folders deleted behind Pravaha's back made the next sync fail once before recovering; it now makes them again within the same sync.

### Checked

- 256 tests pass and 2 are skipped (30 new, in `test/scoring.test.mjs` and `test/v080.test.mjs`); web-ext lint is clean; the failure trials in `docs/FAILURE_RATES.md` are unchanged at 0, 5, 20 and 50 percent of requests failing.
- Real Firefox 160 against fake servers: the existing suites pass (e2e 32 of 32, e2e050 44 of 44, e2e060 12 of 12 and 13 of 13 on a 1,260-article library, shots070 9 of 9 with the Apple fonts, no toasts or flashes while idle); the reader-open check works in Firefox's event page; with the reader closed, polls are skipped until the interval passes; idle polls write none of the heavy keys; delayed writes land and survive a restart; two machines (including one on 0.7.0) converge on history, training and folder order; a hung Miniflux request is abandoned and the next sync runs; the side pane works with j, k, o, Esc, read-on-scroll and the reading keys at 1800, 1920 and 2560 pixels; no console errors.
- Known and left: after the WebDAV folders are deleted, a poll with nothing to send stays green and the state file returns within 15 minutes, when it is next rewritten.
- Not verified against a real Miniflux, Fastmail or Raindrop. The new feed standing and the hot threshold are tuned on synthetic data.

## 0.7.0

Training the ranking is now visible. Nothing in the storage or the event types changed.

### New

- Thumbs up and down on every row and every open card (keys `+` and `-`). A thumb sets a gentle rule (0.3 of a full click) on the article's top three tags and top three words, adds a pull on your interest profile when it is a thumbs up, and says what it trained, with Undo. A second press takes back exactly the rules it set and leaves any rule you set by hand.
- The open card has a **Tags** row and a **Words** row of buttons. One click is more, two is less, three clears; the score updates at once. The old "Why it ranks here" panel keeps the score bars and "Train the whole source" (feed and author).
- Raindrop perspective on the card: your own Raindrop tags for this exact page come first, a line says when and with what note you saved it, and up to two saved pages close in meaning are listed. The weekly digest says "saved in Raindrop" or "close to your Raindrop save", and has a **What you trained** section.
- Fonts: only Apple's New York (reading) and SF Pro (interface), plus the system serif and sans. All open fonts and their licence files were removed, and the `@fontsource` dependencies with them.

### Fixed

- Keyword rules never matched plurals: the buttons trained the raw word while scoring compared stems. Rules now use stems.
- A tag rule matched only the tags Miniflux sent. It now also matches your Raindrop tags of that page and the suggested tags.
- Tag suggestion is about 26 times faster at 3,000 articles and 2,000 saves (7.4 s to 0.28 s, headless Node, synthetic), through an index from words to tags that gives the same results.
- Found in real Firefox: a tag set by a thumb cleared on its first click instead of flipping to "less".
- Found by the failure trial: taking back a thumb that this machine had not yet received wrote an event that left the other machine's rules orphaned. It now writes nothing.

### Checked

- 226 tests pass. Real Firefox 160: thumbs, strip, Raindrop lines, chip clicks and fonts pass against fake servers. `docs/FAILURE_RATES.md` has a new table: at 0, 5, 20 and 50 percent of requests failing, both machines hold the same training and clearing leaves no residue in 60 of 60 trials per row.
- Not verified against a real Raindrop or Miniflux; see README.

## 0.6.1

- Fixed: the Feeds tab showed the word "null" under the list of feeds. The list is now built without it, and a test checks for stray text.

## 0.6.0

Everything below was measured on a synthetic library (541 sidebar rows, 1,260 articles) in real Firefox 160 with the probes in `tools/firefox-e2e/`, or in Node against fakes. They are headless benchmarks on invented data: they show the direction and size of a change, not the speed of your own library on your machine.

### New

- **Feeds tab** in Settings: every feed with its health, a filter, "only feeds with trouble", and Refresh, Rename, Move, Disable or Enable, and Delete (the exact name must be typed; "Disable instead" is offered). The same actions are in the right-click menu on a feed.
- **Folders:** Rename folder (also renames the folders inside it) and Refresh now from the folder menu; Refresh every feed from the All articles menu.
- **Miniflux server tile** on the Sync page: version, a light, "Got it" after a version change, and a read-only "Check server" that lists what it found. The toolbar button shows "!" in amber or red when Miniflux or the storage cannot be reached, the server changed, or its answers stopped matching what Pravaha expects.
- **Contract checking:** every refresh validates the fields it relies on and leaves out anything malformed, so a silent Miniflux update cannot write wrong data. The server light turns red and says which field.
- **Light refresh:** the poll asks for unread entry numbers and downloads only the articles it lacks. It falls back to the full download by itself when the server cannot do this, and the Sync page says which ran, with requests and size.
- A 429 from Miniflux is explained in plain words.

### Faster and lighter

| What | Before | After |
|---|---|---|
| Dragging a top folder: script time per pointer move (median / p95) | 18 ms / 24 ms | 0 ms / 1 ms |
| First move of a drag | 93 ms | 6 to 10 ms |
| Work at the moment of drop | 134 ms | 7 ms |
| Frame time while dragging (p95) | 34 ms | 17 ms (60 frames per second) |
| Open All: first rows on screen | about 750 ms for the whole list | about 230 to 300 ms for the first 40 rows; the rest builds in 9 ms slices |
| Routine two-minute refresh | every unread article body downloaded | numbers only, plus new articles |
| Tree calculation per view | twice | once |
| View payload | unrounded score breakdowns | rounded to three decimals |

Causes found and removed: a cursor set on the whole page during a drag restyled every element; a custom property set on the root did the same; re-appending hundreds of sections is replaced by moving the fewest rows needed; icons are cloned from cached prototypes instead of rebuilt.

### Fixed

- A cleared page badge now falls back to the toolbar-wide badge instead of hiding it.
- The sidebar keeps its scroll position when the list redraws.

### Not verified

- Nothing new was run against a real Miniflux. See README, "What has not been verified".

### Compatibility

- No event type changed. Machines on 0.5.0 and 0.6.0 work together. Keep every machine on 0.5.0 or later, because 0.4.x skips folder-order events.
