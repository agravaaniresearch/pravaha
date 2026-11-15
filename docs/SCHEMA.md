# Schema

## WebDAV layout

```
<root>/events/<device>/0000.jsonl      append-only event segments, 500 events each
<root>/state/<device>.json             head, pushedSeq, appliedHeads, echo snapshot
<root>/lease.json                      optional hand-over marker between machines
<root>/digests/<ISO-week>.md           weekly digest for Obsidian
<root>/enrich/outbox.json              written by Pravaha for outside scoring
<root>/enrich/results.json             written by an outside automation
```

A machine writes only under its own `events/<device>/` and `state/<device>.json`. Two machines therefore never write the same file.

## Event

One JSON object per line.

| Field | Meaning |
|---|---|
| `v` | Schema version, currently 1 |
| `eid` | `device:seq`, unique and the merge key |
| `device` | Machine name |
| `ts` | Hybrid logical clock: 14 digit wall time in milliseconds, 5 digit counter, device name, joined by dots. Sorts as plain text |
| `type` | `open`, `card`, `dwell`, `dismiss`, `undismiss`, `save`, `unsave`, `read_no_open`, `train`, `calibration` |
| `entry` | Miniflux entry id, when the event is about an article |
| `feed` | Miniflux feed id |
| `card` | An article was read as an in-reader card. Logged once per article per session. Adds 0.05 to the feed's standing and a 0.02 pull on the interest profile, against 0.15 and 0.05 for `open` (a background tab) |
| `payload` | Type specific. `dwell`: `{ms}`. `open` and `save`: `{terms, score}` so the interest profile replays identically. `train`: `{type, key, value}` |

Rules that make merging safe:

- Merge is a set union by `eid`. Duplicates are ignored. Invalid lines are counted and skipped.
- Derived state is a pure function of the sorted event list and the current time. Same events, same result.
- `undismiss` and `unsave` undo the matching earlier event. A later `train` for the same type and key replaces an earlier one, and value 0 removes the rule.

## Derived state

- **Feed standing** = clamp(0.3 + sum of signals each multiplied by 0.5^(age / 14 days)). Signals: open +0.15, dwell over 15 seconds +0.10, read without opening or dismiss -0.05, save +0.25, unsave -0.25.
- **Interest profile.** A recency weighted mean of Raindrop bookmark vectors (half life 365 days), pruned to 500 terms. Each open pulls it at rate 0.05 and each save at 0.12.
- **Echo profile.** A vector and domain counts built from bookmarks and history, exchanged between machines as snapshots in `state/<device>.json`.

## Score

```
final = clamp( (0.40*tag + 0.30*echo + 0.20*standing + 0.10*freshness + training) * novelty )
tag, echo   = 1 - exp(-3 * cosine)        (echo adds 0.15 to the cosine when the domain has 3 or more visits)
freshness   = 1 / (1 + (hours/24)^1.129)  (0.5 at one day, about 0.1 at one week)
training    = clamp(sum of rule values * 0.08, -0.2, 0.2)
novelty     = 1.08 for a feed not opened this session, else 1
with outside score s:  final = 0.8*final + 0.2*s
```

## Enrichment files

`outbox.json`: `{version, createdAt, instructions, centroidTerms, items:[{id,title,summary,url,feed,localScore}]}`

`results.json`: `{"version":1,"results":[{"id":123,"score":0.7,"flag":"serendipity","note":"why"}]}`. Scores outside 0 to 1 and malformed rows are rejected and counted.

## Local storage keys

`settings`, `cache` (articles, feeds, and `recent`), `bodies` (article HTML fetched on demand, trimmed with the cache), `icons` (feed icons as data URLs), `searchIndex`, `events`, `syncState`, `pendingOps` (Miniflux changes waiting to send), `raindropCache`, `echoLocal`, `enrichment`, `net`, `others`, `pendingHistory`. Dwell tracker state is kept in `storage.session` because the background page can unload.

### `pendingOps`

An array of changes waiting for Miniflux, oldest first. `{op:"status", ids:[...], status:"read"|"unread"}` or `{op:"bookmark", id, desired}`. A status op is sent in chunks of 150 ids. After each chunk that Miniflux accepts, those ids are removed from the op, so a retry resends only what has not arrived. An op being sent is marked `inflight` in memory only and is never merged into.

### `cache.recent`

`{ "<entryId>": { t, n } }`. The articles marked read on this machine in the last ten minutes: `t` is when, `n` is how many times a refresh has sent the read again. If a refresh finds one of them still unread on Miniflux, it queues the read again instead of reverting the local copy, up to three times (`n`), then believes Miniflux. Marking an article unread removes it. The window is ten minutes so that a deliberate "mark unread" made on another machine is not fought over for long.

### `searchIndex`

`{ "<entryId>": { id, fi, f, t, g, k, s, p, u, c } }`: feed id, feed title, title, tags, keywords, a 200 character summary, published time (ms), article URL and folder. `k` holds about fourteen keywords from the full text, added when the article body has been loaded. The index is kept for 400 days (`settings.searchKeepDays`) for articles that have left the reading cache, never for more than 20,000 entries, and it is local to the machine: it is not written to WebDAV. Opening an indexed article that is no longer cached fetches it from Miniflux again.

### `settings` additions in 0.3.0

`treeOrder`: `{ "<parent folder id or root>": ["<child id>", ...] }`. The saved order of folders and feeds within each parent. Anything not listed follows alphabetically after the listed ones, and folders always come before feeds. It is part of `settings`. From 0.4.0 it travels through Firefox Sync as the `order` part; it is not written to WebDAV.

`searchKeepDays`: days to keep articles in the search index after they leave the reading cache. Default 400.

### Status report

`status()` now also returns `activity` (`null` or `{kind, label, done, total}` with kind `push`, `pull`, `verify`, `search`, `discover` or `subscribe`) and `pendingCount` (ids waiting for Miniflux). Rows in a view carry `pending: true` while their change is waiting. Nothing about these is stored.

### Interface preferences

Interface preferences (theme, palette, density, thumbnails, read on scroll, reading font, interface font, confirm mark read, reading size, line gap, width, Bionic reading and its strength) and collapsed feeds live in the reader page's `localStorage` under `pravaha.ui` and `pravaha.collapsed`. The reader keeps them in `localStorage` as a fast cache and, from 0.4.0, mirrors them into `settings.ui` (with a timestamp, `pravaha.ui.at`) through the `saveUi` message, debounced by 500 ms. A newer `settings.ui` that arrives from Firefox Sync or a settings file is adopted at the next start or on a `profile` message. Collapsed feeds stay on the machine.

### Fonts

Bundled fonts: OFL, except Ubuntu (Ubuntu Font Licence 1.0); licences are in `extension/ui/fonts/`. Reading ids: `newsreader`, `literata`, `newyork`, `sourceserif`, `lora`, `crimson`, `merriweather`, `system`, `atkinson`, `sfpro`, `ubuntu`. Interface ids: `plex`, `sourcesans`, `atkinson`, `sfpro`, `ubuntu`, `system`. `newyork` and `sfpro` are Apple fonts, present only in a locally built extension (`extension/ui/fonts/apple/`, git-ignored); the reader probes for them and disables the card when absent. An unknown or removed id falls back to the default. The `FONT_INFO` table in `ui/prefs.js` holds each font's group and one-line note. Only the Latin subset of each is bundled.

### `settings` additions in 0.4.0

- `installId`: random 12 characters made on first start. The state file `state/<machine>.json` carries it as `installId`. If a sync finds the state file of the same machine name with a different `installId`, nothing is written and the sync stops with `code: "name-clash"`; `status().nameClash` is `{device, since}`.
- `device` default is `browser-xxxxx` (random). The old default `this-machine` is renamed only while nothing has been written under it.
- `sync`: `{keys: bool, settings: bool}`, both default true, local to the machine, never carried.
- `syncMeta`: `{ "<part>": {at, hash} }`, what was last sent or taken for each part. Local only.
- `ui`: the look-and-feel preferences, as above.
- `syncCreds` is gone. The old Firefox Sync item `pravahaCreds` is read once if the machine has no Miniflux key.

### Firefox Sync items (`browser.storage.sync`)

Four items, each `{ v: 1, at: <ms>, by: <machine name>, data }`. The newest `at` wins per part. Firefox's documented limits are about 100 KB in total, 8,192 bytes per item and 512 items; a part whose serialised item is over 7,600 bytes is kept on the machine and reported in plain words, and the other parts still go. These limits come from documentation and were not re-checked in 0.4.0.

| Item | Contents |
|---|---|
| `pv:keys` | Miniflux address and key, WebDAV address, user, app password and folder, Raindrop token. Sent only by a machine that holds at least one key. |
| `pv:settings` | `weights`, `pollMinutes`, `novelty`, `palette`, `theme`, `retentionDays`, `autoTag`, `autoDigest`, `saveToRaindrop`, `searchKeepDays`. Never `device`, `installId`, `sync` or `syncMeta`. |
| `pv:order` | `treeOrder` |
| `pv:ui` | `settings.ui` |

Pulls happen at start-up and on every `storage.onChanged` for a `pv:` key. A machine that has never held a key never writes. Taking keys starts a sync at once.

### Settings file

`{ format: "pravaha-settings", version: 1, exportedAt, from, settings, order, ui, keys, events? }`. `keys` is `null` or `{kdf: "PBKDF2-SHA256", iter: 250000, cipher: "AES-256-GCM", salt, iv, data}` (base64), sealing the same object as `pv:keys`. `events` is the event log, present only when the user ticked history; importing merges it by set union, so importing twice adds nothing. Files with a larger `version` are refused. The machine name is never read from the file.

### Messages added in 0.4.0

`profileSync` (summary of the four parts), `profilePull {force}`, `profilePush`, `exportSettings {keys, passphrase, history, ui}`, `importSettings {text, passphrase}`, `saveUi {ui}`. `status()` gains `scope` (`none`, `miniflux`, `full`), `imported` (`{at, events, devices}` after history arrives) and `nameClash`. `overall` is `off` when Miniflux is not configured.

## Miniflux calls

Read: `/me`, `/feeds`, `/categories`, `/entries` (with `status`, `starred`, `changed_after` and, for older articles, `search`), `/entries/{id}`, `/feeds/{id}/icon`. Write: `PUT /entries` (status, in chunks of 150), `PUT /entries/{id}/bookmark`, `GET /entries/{id}/fetch-content`. New in 0.3.0: `POST /discover` and `POST /feeds` and `POST /categories`, only when the user presses Find feeds, Subscribe or a new folder name.
