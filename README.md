# Pravaha

Pravaha is a Firefox extension that turns a hosted Miniflux server into a personal reader. It ranks your unread articles by how closely they match what you already save, read and act on. The name is Sanskrit for flow.

Miniflux keeps the feeds, read state, stars and folders. Pravaha adds a relevance engine, a reader screen, an event log that keeps two machines in step through Fastmail WebDAV, and optional one-way saving to Raindrop.

## What it does

- **Reads from Miniflux.** Folders are Miniflux categories. A slash makes a nested folder, so `Defence/Shipbuilding` appears as Shipbuilding inside Defence.
- **Ranks with four signals.** The score is 0.40 tag match, 0.30 sites you read, 0.20 feed standing and 0.10 freshness. Training rules add or subtract up to 0.2. Feeds you have not opened this session get a small novelty boost. All weights are editable in Settings.
- **Reads in place.** Opening an article shows it as a card inside the list, in Newsreader or Literata. Press `w` (the coffee cup) to ask Miniflux for the complete article. Press `b` to open it in a background tab. Both are logged, and a background open counts more than a card read.
- **Stays organised.** Feeds are collapsible sections with their Miniflux icon and an unread count. Marking a section read folds it away. Articles can be marked read as they scroll past the top. The tabs are Newsfeed, Saved, Stats, Sync and Settings.
- **Uses what Miniflux offers.** Thumbnails, reading time, word count, comment links, tags, audio and video enclosures and the full-article flag show as small chips.
- **Offers Bionic reading** (off by default; a button in the top bar and on every card, or `Shift+B`): the first part of each word is bolded to give the eye a landing point. A strength control runs from lightest to strongest. The word rules are Bionify's, vendored unchanged in `extension/vendor/bionify.mjs` (see the licence section), and applied to the article as DOM nodes rather than HTML. The idea was prompted by the Open|Bionic project. It skips headings and code and works on Latin script only. Independent evidence that it speeds reading is weak, so treat it as a preference.
- **Searches everything it has seen.** Loose, typo-tolerant full-text search with `#tag`, `feed:name`, `"exact phrase"`, `-word`, `in:read|unread|saved` and `since:30d`. A compact index keeps articles you read months ago findable after their text has left the reading cache, and a button asks Miniflux itself for older ones.
- **Marks read reliably.** `Shift+A` marks the section read (with nothing selected it acts on the first section on screen), `Shift+M` marks everything in the current view. The reader works by section, folder or all, not by the rows on screen, sends in chunks, then asks Miniflux which articles are still unread and sends those again. The message says what Miniflux confirmed and has Undo.
- **Shows when it is talking to Miniflux.** A bar under the top edge, a pill with "Sending changes to Miniflux, 120 of 400", a small spinner on each article still on its way, a progress line under each section, then "Synced with Miniflux".
- **Asks before marking a whole section or folder** (settings: never, sections and mark all, always).
- **Reorders top-level folders by dragging them** (the cursor becomes a hand), with Alt+Up and Alt+Down as a keyboard alternative. The order reaches your other machines through Firefox Sync and through the reading-history log. Feeds are listed alphabetically inside each folder; their names and folders are set in Miniflux.
- **Has a right-click menu on the folder list** (folders, feeds and All articles): Mark all read, with the same confirmation setting and an Undo, and Move up or Move down for top-level folders.
- **Adds feeds from a website.** Press `a`, paste an address, Miniflux finds the feeds on it, pick one and a folder (or make a new one). Right-click any page or link, then "Subscribe with Pravaha", to open the same dialog with that address filled in.
- **Manages feeds without leaving the reader (0.6.0).** Settings, Feeds lists every feed with its health, a filter and "only feeds with trouble". Rename, move to a folder (or a new one), disable or enable, refresh now and delete are there, and also in the right-click menu on a feed. Folders can be renamed and refreshed from their menu, and "Refresh every feed" is on the All articles menu. Every change is made in Miniflux first, then shown here. Delete needs the exact name typed and offers Disable instead.
- **Watches the Miniflux server for silent changes (0.6.0).** The Sync page has a Miniflux server tile with the version, a light, and a read-only "Check server" button. Every refresh checks that Miniflux's answers have the fields Pravaha relies on and leaves out anything that does not, so a server update cannot quietly write wrong data. A changed version turns the light amber until you press "Got it", and the toolbar button wears a small "!" in amber or red.
- **Refreshes lightly (0.6.0).** The two-minute poll asks Miniflux which articles are unread (numbers only) and downloads just the ones it lacks, instead of every unread article. If the server cannot do that, Pravaha falls back to the full download by itself and says so on the Sync page.
- **Has an OLED black theme** besides light and dark, eleven reading fonts and five interface fonts, chosen from labelled cards with a live sample (all open fonts bundled; Apple's SF Pro and New York can be added for your own build, see below), and reading controls for size, line gap and width.
- **Shows relevance as colour.** There are no Good, Great or Best tiers. Each row has a bar and a chip that darken as the score rises. Three palettes are included: ember, saffron and moss.
- **Learns from what you do.** Opening in a tab, reading a card, reading for more than 15 seconds, saving and dismissing all move a feed's standing. They fade with a 14 day half life. Opens and saves also pull your interest profile toward the article.
- **Trains like NewsBlur.** Open an article's details and choose More or Less for the feed, the author or a keyword.
- **Suggests tags locally.** Suggestions come from your own Raindrop tag vocabulary. No model and no network call is involved.
- **Syncs two machines safely.** Every action is an event in an append-only log. Each machine writes only its own files, so they cannot overwrite each other. Merging is a set union, so the order of arrival never changes the result.
- **Tells you the state in plain words.** Settings and Sync are folder-tabbed pages. Sync is a dashboard with a status ring, a tile per service and per machine, and small graphs; every tab carries a status lamp.
- **Moves your whole setup between machines.** Keys, settings, folder order and look travel through Firefox Sync by themselves; a new machine shows three set-up routes (Firefox Sync, a settings file, typing the keys) and then imports articles and reading history with a progress message. The settings file seals keys with a passphrase. Two installs with the same machine name are stopped before they can mix history.
- **Never says "In sync" falsely.** With nothing connected the pill says "Not set up"; with only Miniflux it says "Miniflux in sync". Background polls are quiet and do not redraw the page.
- **Writes a weekly digest** to the WebDAV folder as Markdown with Dataview front matter, for Obsidian.
- **Accepts outside scores.** A Grok automation, or anything else, can write `enrich/results.json`. Pravaha blends 20 percent of that score with 80 percent of its own.

## Screenshots

All screenshots show synthetic data: invented feeds, invented articles and fake servers. They are taken by `tools/screenshots/shoot.py`, which runs the real reader screen in Chrome against the test fakes, so they can be regenerated at any time.

| | |
|---|---|
| ![Newsfeed in OLED black](docs/screenshots/01-newsfeed-oled.png)<br>**Newsfeed, OLED black.** Folders and feeds on the left, collapsible feed sections, a relevance bar and score on every row. | ![A collapsed feed](docs/screenshots/02-collapsed-feed.png)<br>**Collapsed feed.** A section folds to one line. Marking a section read folds it too. |
| ![Article card in dark theme](docs/screenshots/03-card-dark.png)<br>**Reading in place.** Opening a title shows a card with the article, a background-open button (`b`) and the full-article button (`w`). | ![Bionic reading in the light theme](docs/screenshots/04-card-anchor-bolding-light.png)<br>**Bionic reading** in Literata on the light theme. Optional and off by default. |
| ![Reading controls](docs/screenshots/05-reading-controls.png)<br>**Reading controls.** Type, size, line gap, width, Bionic reading and a live preview. | ![Stats](docs/screenshots/06-stats.png)<br>**Stats.** What you read, opened, saved and dismissed over 30 days. |
| ![Sync status](docs/screenshots/07-sync-status.png)<br>**Sync.** Plain-words status lights for every connection and machine. | ![Settings with inline test](docs/screenshots/08-settings-inline-test.png)<br>**Settings.** The key is tested inline as soon as it is typed. |

![Narrow window](docs/screenshots/09-narrow-window.png)

New in 0.3.0:

| | |
|---|---|
| ![Search](docs/screenshots/10-search.png)<br>**Search.** Fuzzy, with highlights, `#tag` and `feed:` filters, and a button to search Miniflux for older articles. | ![Confirm mark all](docs/screenshots/11-confirm-mark-all.png)<br>**Confirm mark read.** Sections and mark all ask first by default. |
| ![Syncing with Miniflux](docs/screenshots/12-syncing-with-miniflux.png)<br>**Syncing.** The top-right pill and a bar on each section show changes still going to Miniflux. | ![Toast with undo](docs/screenshots/13-toast-with-undo.png)<br>**Toasts.** Every bulk action reports whether Miniflux confirmed it, with Undo. |
| ![Reorder folders](docs/screenshots/14-reorder-folders.png)<br>**Reorder.** Move folders and feeds up and down. | ![Add a feed](docs/screenshots/15-add-feed.png)<br>**Add a feed.** Paste a site, pick a discovered feed and a folder. |
| ![Bionic button](docs/screenshots/16-bionic-button-and-fonts.png)<br>**Bionic button** in the top bar and on the card. | ![Fonts and confirm settings](docs/screenshots/17-settings-fonts-and-confirm.png)<br>**Fonts and Marking read** settings. |
| ![Font picker](docs/screenshots/18-font-picker.png)<br>**Font picker (0.3.1).** Serif and sans groups, each card in its own font. SF Pro and New York show "Not in this build" until you build them locally. | |

New in 0.4.0 (these three were taken in real Firefox 160, with synthetic data):

| | |
|---|---|
| ![Set up this machine](docs/screenshots/19-set-up-this-machine.png)<br>**Set up this machine.** A fresh install shows three routes and says "Not set up", never "In sync". | ![Move setup](docs/screenshots/20-move-setup.png)<br>**Move setup.** Firefox Sync status for each part, two switches, and the settings file below. |
| ![After arrival](docs/screenshots/21-after-arrival.png)<br>**After arrival.** Keys, look and articles carried to the second machine, which then reads the history. | |

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

New in 0.6.0, the same invented library, continued (`node tools/example-run.mjs` prints the whole run):

```
Second refresh on the laptop (nothing new):
  light refresh, 4 requests, 662 bytes
After one new article: light refresh, 5 requests, 987 bytes

Feed management:
  Renamed to “Table Talk Weekly”.
  Moved “Table Talk Weekly” to Food/Baking.
  Disabled “Table Talk Weekly”. Miniflux will stop fetching it until you enable it again.
  Renamed “Defence” to “Maritime”.
  The name typed did not match the feed, so nothing was deleted.

Check server (read-only):
  green  Version: Miniflux 2.3.5.
  green  Entry numbers: working (4 unread). Refreshes download only what is new.
  green  New articles: working.
  green  Feeds: 4 read.
  off    Refreshing one folder is not tried here, because it would make Miniflux fetch feeds. It is checked the first time you use it.

Folder tree now:
  Maritime (2)
    Shipbuilding (2)
      Harbour Weekly (2)
  Food (2)
    Baking (1)
      Table Talk Weekly (1)
    Old Blog (1)
  Medicine
    Clinic Notes
```

Reading it: with nothing new the second refresh is a light one that asks for numbers only; a single new article adds one request. The feed changes are made in Miniflux and shown in the folder tree. Renaming "Defence" also renamed the folder inside it, because folders are Miniflux categories whose titles are paths. A delete with the wrong name is refused. The check reads only; the last line is there because trying a folder refresh would make Miniflux fetch real feeds. The code, the servers and every number above are synthetic and illustrative; they say how the program behaves, not how your Miniflux will.

## Getting started

1. **Prerequisites.** Firefox on desktop, a Miniflux server (hosted or self-hosted) with an API key from Miniflux, Settings, API Keys, and optionally a Fastmail app password with Files access (for syncing two machines) and a Raindrop test token (for tag suggestions and saving).
2. **Install.** Download the signed `pravaha-<version>.xpi` from the releases page, open `about:addons`, click the gear icon and choose Install Add-on From File. See [DEPLOY.md](DEPLOY.md) for building and signing it yourself.
3. **Connect.** Click the Pravaha button. The Settings page opens on Connections. Type the Miniflux address and key; the connection is tested as soon as both boxes are filled and the result appears under the box. Do the same for WebDAV and Raindrop if you use them, then press Save and test. A custom server address makes Firefox ask for permission once.
4. **Read.** Open the Newsfeed. Feeds are grouped under their Miniflux folders, ranked by relevance within each section.

## Using the reader

| Key | Action |
|---|---|
| `j` / `k` | Next and previous article |
| `o` or Enter | Open the article as a card in the list |
| `b` | Open the article in a background tab (counts as a full open for ranking) |
| `w` | Fetch the complete article through Miniflux (the coffee cup) |
| `s` | Save (star in Miniflux, and to Raindrop if enabled) |
| `m` | Toggle read |
| `x` | Dismiss (lowers the feed's standing a little; Undo dismissed is in the toolbar) |
| `Shift+A` | Mark the section read and fold it (asks first by default; works with nothing selected) |
| `Shift+M` | Mark everything in the current view read (asks first by default) |
| `Shift+B` | Bionic reading on or off |
| `a` | Add a feed from a website |
| `c` | Fold or unfold the section |
| `Shift+C` | Collapse or expand every feed |
| `u` | Switch between Unread and All |
| `r` | Sync now |
| `/` | Search everything |
| `Esc` | Close the card |

- **Read on scroll** is a toolbar toggle. It marks an article read only after you have seen it and it leaves through the top of the screen, and it is neutral for ranking.
- **Mark section read** marks every unread article of that feed read in Miniflux, including ones not shown because the list is long, and folds the section away. Undo is on the message that follows.
- **Themes:** light, dark and OLED black, plus three relevance palettes (ember, saffron, moss).
- **Reading type:** serifs (Newsreader, Literata, New York, Source Serif, Lora, Crimson Pro, Merriweather, the system serif) and sans fonts (Atkinson Hyperlegible, SF Pro, Ubuntu) for articles; IBM Plex Sans, Source Sans, Atkinson Hyperlegible, SF Pro, Ubuntu or the system font for the interface. Settings shows each as a card set in its own font, with a one-line note on what it suits. All the open fonts are bundled, so nothing loads from the web.
- **Apple fonts (SF Pro, New York), personal builds only:** Apple's fonts are not in this repository and must not be added to it. Run `pip install fonttools brotli`, then `python3 tools/apple-fonts.py`. It fetches the community SFWindows collection, cuts small Latin files into `extension/ui/fonts/apple/` (git-ignored) and the next build includes them. Without them the two cards show "Not in this build" and cannot be chosen. Never share an extension built this way. Size, line gap, width and Bionic strength are in the Aa menu and in Settings.

### Searching

Type in the box at the top (or press `/`). Words are matched loosely: a misspelling, a different ending or half a word still finds the article, and every word has to match somewhere (title, tags, feed name, excerpt or the keywords taken from the full text). Results are highlighted. Pick Everything, Unread, Read or Saved to narrow them.

| You type | It finds |
|---|---|
| `frigte shipyrd` | Articles with words close to both (typos allowed) |
| `#navy` | Articles tagged navy |
| `feed:naval` | Articles in a feed whose name starts with naval |
| `"lemon cake"` | The two words together |
| `lemon -cake` | Lemon, but not cake |
| `in:read frigate` | Only articles already read (`in:unread`, `in:saved`, `in:all`) |
| `deficit since:30d` | Articles from the last 30 days |

The local index covers every article Pravaha has seen in the last 400 days, including ones whose text is gone from the reading cache; those show an Archive chip, and opening one fetches it from Miniflux again. If nothing local matches, **Search Miniflux for older** asks your Miniflux server and adds what it finds to the index.

### Adding a feed

Press `a` or the plus in the sidebar. Paste a website or feed address and press Find feeds. Miniflux's own server looks at the page and lists the feeds it found; ones you already follow are greyed. Pick one, choose a folder (the current folder is preselected) or "New folder" (use `/` for a sub-folder, like `News/World`), then Subscribe. The feed and its first articles appear straight away. From any web page, right-click and choose "Subscribe with Pravaha" to open the same dialog with that address filled in.

### Reordering folders

Grab a top-level folder in the sidebar and drop it where you want it; a line shows where it will land. The article list follows the sidebar. Right-click a folder and choose Move up or Move down, or press Alt with the arrow keys on a focused folder, if you would rather not drag. Only top-level folders move. Miniflux itself has no manual feed order, so feeds are listed alphabetically inside each folder, and their names and folders are set on the Miniflux website. The order is written to the reading history as an `order` event and to Firefox Sync, so every machine follows it. Machines still on 0.4.x cannot read that event, so update all of them.

### Feeds on web pages

Right-click a page or link and choose "Subscribe with Pravaha". Optionally, turn on Settings, This machine, "Detect feeds on pages": Pravaha explains what it needs, then Firefox asks for permission to run on all websites. With it on, the toolbar icon turns amber and shows a count on pages that announce a feed, and clicking it lists them with a Subscribe button. The script reads only the feed links in the page's head and sends them to Pravaha inside the browser. Turn it off and the permission is given back. Without it, right-click subscribe keeps working.

## How ranking works

Each unread article gets a score from 0 to 1: 0.40 tag match against your own Raindrop tag vocabulary, 0.30 echo (sites you read, from local history and bookmarks), 0.20 feed standing (learned from your actions) and 0.10 freshness. Training rules from More and Less buttons add or subtract up to 0.2, and feeds you have not opened this session get a small novelty boost. The score is stretched for display and shown as colour and a number, never as tiers.

| Action | Effect on the feed's standing | Pull on your interest profile |
|---|---|---|
| Open in a background tab (`b`) | +0.15 | 0.05 |
| Read as a card | +0.05 | 0.02 |
| Reading for more than 15 seconds | +0.10 | none |
| Save | positive | yes |
| Dismiss | negative | none |

Everything fades with a 14 day half life. The full schema, including the event log, is in [docs/SCHEMA.md](docs/SCHEMA.md).

## Architecture

```
Miniflux (feeds, entries, read state, stars, icons, full-article fetch)
        |
 background page (engine: scoring, event log, retention, sync, pending queue)
        |                          |
 reader page (UI)          Fastmail WebDAV (append-only event files, one per machine)
                                   |
                           Raindrop (optional: tag vocabulary, one-way saving)
```

- `extension/src/engine.js` holds the state and the rules; `eventlog.js` merges events by set union; `scoring.js` scores; `miniflux.js`, `webdav.js` and `raindrop.js` are thin clients; `handlers.js` is the message layer between the reader and the engine; `safehtml.js` sanitises article HTML; `anchor.js` applies Bionic reading; `search.js` does the fuzzy search and its query language.
- The reader page never uses `innerHTML` for article text. Article HTML is parsed in an inert document and only allowlisted elements are rebuilt as DOM nodes.

New in 0.5.0 (taken in real Firefox 160 with synthetic data; the machines, folders and feeds are invented):

| | |
|---|---|
| ![Sync dashboard](docs/screenshots/22-sync-dashboard.png)<br>**Sync dashboard.** A status ring, a tile per service and a four-part Firefox Sync bar. | ![Machines](docs/screenshots/23-sync-machines.png)<br>**Machines.** One tile per machine with its history count and state. |
| ![Firefox Sync tab](docs/screenshots/24-sync-firefox.png)<br>**Firefox Sync tab.** The four parts it carries, each with a lamp. | ![Settings, Connections](docs/screenshots/25-settings-connections.png)<br>**Settings as folder tabs,** each with an icon and, where it applies, a lamp. |
| ![This machine](docs/screenshots/26-settings-this-machine.png)<br>**Feeds on web pages.** The switch is off until you turn it on. | ![Explanation](docs/screenshots/29-detect-explanation.png)<br>**Pravaha explains the permission first,** then Firefox asks. |
| ![Dragging a folder](docs/screenshots/27-drag-folder.png)<br>**Dragging a folder.** A drop line shows where it will land. | ![Right-click menu](docs/screenshots/28-right-click-menu.png)<br>**Right-click** on a folder: Mark all read, Move up, Move down. |

## Privacy and security

No telemetry. Data goes only to servers you configure. Credentials are stored unencrypted in the Firefox profile (use a limited app password and a revocable Miniflux key). Thumbnails and article images load from publishers' sites and can be switched off. See [docs/POLICY.md](docs/POLICY.md) for the full review.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Red light on Miniflux | Wrong address or key, or the key was revoked. Retest on Settings, Connections. |
| WebDAV test fails | Use a Fastmail app password with Files access, not the account password. |
| Firefox asks for permission on Test | You entered a custom server address; allow it once. |
| Full article button does nothing useful | Miniflux could not fetch that page (paywall or blocking). The excerpt stays. |
| Two machines rank slightly differently | Expected until both hold the same history and Raindrop data. |
| A feed shows a red dot | Miniflux reports parsing errors for it; it is excluded from ranking. |
| "Marked N read" but some came back unread | The message says how many Miniflux did not accept. They are sent again on the next refresh, up to three times. If they keep returning, check Miniflux's own state for those entries. |
| The pill says "Needs attention" after marking read | Miniflux could not be reached; the changes wait and send when it answers. The sync page shows how many. |
| Find feeds says Miniflux said something | The text after "Miniflux said" is Miniflux's own answer, for example that no feed was found on that page. |
| A search result has an Archive chip | Only the index remembers it; clicking it fetches the article from Miniflux again. |

## Development

```
npm install
npm test            # 143 tests: engine, event log, sync, services, search, bulk marking, reader screen under jsdom
npm run lint        # Mozilla's web-ext lint
node tools/failure-rates.mjs 150 --write
node tools/example-run.mjs
python3 tools/screenshots/shoot.py   # regenerates docs/screenshots (needs Chrome and playwright)
node tools/firefox-e2e/serve.mjs 8799 & python3 tools/firefox-e2e/e2e.py   # real Firefox, two profiles (see DEPLOY.md, section 7)
```

## Install (short version)

See [DEPLOY.md](DEPLOY.md). The short version: download `pravaha.xpi` from the latest release, open `about:addons` in Firefox, click the gear icon and choose Install Add-on From File. Then open the extension's button, go to Settings and enter your Miniflux address and API key.

## Tests

```
npm install
npm test                       # 200 tests
node tools/failure-rates.mjs   # random failure injection, see docs/FAILURE_RATES.md
npm run lint                   # Mozilla's web-ext lint
```

The tests run in Node against in-memory fakes of Miniflux, WebDAV and Raindrop. They cover scoring, the event log, two-machine convergence, offline queues, corrupted files and the engine end to end. The reader screen itself is driven under jsdom against the real engine: opening cards, the sanitiser, collapsing, read on scroll, settings tests, themes and shortcuts. The jsdom run found one real bug, now fixed: Undo dismissed did not make the article unread again. The failure harness found and fixed one real bug: two overlapping Miniflux updates could drop a read. It is covered by a regression test.

## What has not been verified

- **Everything new in 0.6.0 is untested against a real Miniflux.** The entry-number call (`GET /entries/ids`, Miniflux 2.3.2 or newer), the position marker (`after_entry_id`), feed and folder changes (`PUT /feeds/{id}`, `PUT /categories/{id}`, `DELETE /feeds/{id}`) and the refresh calls follow the documentation and are tested against fakes and in real Firefox against a fake server. The Check server button on the Sync page is how you find out on your own server; if a call is missing there, Pravaha uses the older path by itself. Folder and all-feed refresh only show their effect the first time you use them. A folder rename that fails part-way leaves some folders renamed; the message says which, and the page then follows Miniflux.
- **Speed numbers are from a headless benchmark on synthetic data** (see CHANGELOG), not from your library on your machine.
- **Real Firefox, with limits.** Since 0.4.0 the setup-moving, status and quiet-poll behaviour is exercised in real Firefox 160 (the base of Zen) with `tools/firefox-e2e/`. Zen itself, a long-running profile and the older 0.3.x screens (scroll behaviour, the right-click menu) have not been driven that way.
- **Firefox Sync's cloud was not reached.** The e2e copies `storage.sync` items between profiles, which is what Firefox does, but real delivery, its timing, the size limits quoted in SCHEMA.md and the "Add-ons ticked" requirement come from documentation and are unverified.
- **New Miniflux calls in 0.3.0 are untested against a real server.** `POST /discover`, `POST /feeds`, `POST /categories`, the `search` filter on `/entries`, and the chunked `PUT /entries` with a read-back check follow the documented API and are tested against fakes only. How Miniflux words its errors, and how long a new feed takes to fetch its first articles, are guesses from the documentation. If one misbehaves, the message shown is Miniflux's own.
- **The browser's own right-click menu item ('Subscribe with Pravaha') is not exercised by the e2e.** WebDriver cannot drive Firefox's page context menu. The code behind it and the `#subscribe=` hand-off are tested, and the sidebar menu, drag-and-drop and feed detection (with the optional permission) were driven in real Firefox 160.
- **Feed detection is checked on simple pages.** Sites that add their feed link late, inside frames, or only as a plain link in the body are not detected. Firefox's own permission prompt was switched off by a test preference, so its wording as Firefox shows it was not seen.
- **The "some remain unread" fix is tested against a fake that drops ids.** The cause in your Miniflux is inferred from how the reader worked, not observed. The check afterwards is what makes the outcome visible either way.
- **Two Miniflux calls are untested against a real server.** Full-article fetch (`/entries/{id}/fetch-content`) and feed icons (`/feeds/{id}/icon`) follow the documented API and are tested against fakes only.
- **Not run against real servers.** The Miniflux, Fastmail WebDAV and Raindrop calls follow their documented APIs and are tested against fakes only. The Miniflux `changed_after` filter is the least certain of them.
- **Two machines can score slightly differently** until both hold the same Raindrop data, history snapshots and events. The order of articles is usually the same. Small differences in the number are expected.
- **No Web Worker yet.** Scoring runs on the main thread of the background page. It is fast at a few thousand articles. A worker is a later step if it is ever needed.
- **Keys travel through Firefox Sync by default from 0.4.0**, with two switches to stop it. This departs from the Grok spec, which kept them local.

## Shortcuts

`j` and `k` move. `o` or Enter opens the card. `b` opens a background tab. `w` fetches the full article. `s` saves. `m` toggles read. `x` dismisses. `c` folds a section and `Shift+C` folds every one. `Shift+A` marks the section read, `Shift+M` marks everything in view read. `Shift+B` toggles Bionic reading. `a` adds a feed. `/` searches. `u` switches Unread and All. `r` syncs. Esc closes the card or a dialog. `?` lists them.

## Layout

```
extension/          the add-on (manifest, background page, reader screen, modules in src/)
test/               node:test suites and the fake servers
tools/              failure-rate harness and the synthetic example
docs/               schema, policy review, failure rates
.github/workflows/  test, lint, sign and release
```

See [docs/SCHEMA.md](docs/SCHEMA.md), [docs/POLICY.md](docs/POLICY.md) and [docs/FAILURE_RATES.md](docs/FAILURE_RATES.md).

## Licence

Pravaha includes code from Bionify (GPL-3.0), so it is released under the GNU General Public License v3. The full text is in `LICENSE`. Bundled fonts are under the SIL Open Font Licence, except Ubuntu, which is under the Ubuntu Font Licence 1.0 (see `extension/ui/fonts`). SF Pro and New York belong to Apple and are not included.

## Disclaimer

Pravaha is a personal reading tool provided as is, with no warranty. It ranks articles by similarity to your own habits. It does not judge whether an article is true, current or clinically sound, and a high score is not an endorsement. Do not use it as the basis for medical, legal or financial decisions. The example above contains only invented data. Keep your API keys private, use a Fastmail app password rather than your main password, and rotate any key that has been shared.

