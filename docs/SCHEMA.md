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
| `type` | `open`, `card`, `dwell`, `dismiss`, `undismiss`, `save`, `unsave`, `read_no_open`, `train`, `calibration`, `order` (from 0.5.0) |
| `entry` | Miniflux entry id, when the event is about an article |
| `feed` | Miniflux feed id |
| `card` | An article was read as an in-reader card. Logged once per article per session. Adds 0.05 to the feed's standing and a 0.02 pull on the interest profile, against 0.15 and 0.05 for `open` (a background tab) |
| `payload` | Type specific. `dwell`: `{ms}`. `open` and `save`: `{terms, score}` so the interest profile replays identically. `train`: `{type, key, value}`; for `type: "story"` also `keys` (the tag and keyword rules that thumb set, so it can be undone exactly) and, for a thumbs up, `terms` (the article's top stems, which pull the interest profile at rate 0.08). `order`: `{scope, ids}` |

Rules that make merging safe:

- Merge is a set union by `eid`. Duplicates are ignored. Invalid lines are counted and skipped.
- Derived state is a pure function of the sorted event list and the current time. Same events, same result.
- `order` records the full order of the top-level folders after a drag or a Move up/down. `scope` is `"root"` (the only scope written by 0.5.0), `ids` is the ordered list of folder ids such as `cat:Defence`, followed by the ids of anything else at that level. The event with the latest `ts` for a scope wins. A machine uses the event order only when the event's wall time is later than `settings.treeOrderAt`, the time of the last order change made or received through Firefox Sync, so the two routes cannot disagree for long. Feeds are never reordered by Pravaha; their order is set in Miniflux. Versions before 0.5.0 count an `order` line as an invalid line, so update every machine.
- `undismiss` and `unsave` undo the matching earlier event. A later `train` for the same type and key replaces an earlier one, and value 0 removes the rule.
- **Training rules (`train`).** `type` is `tag`, `keyword`, `feed`, `author` or `story`; `key` is lower case; `value` is a finite number from -3 to 3 (the screen writes 1, -1 or 0 for a click, and +/-0.3 for the rules a thumb sets). `tag` rules match an article's tags: the ones the feed sent, the tags of your own Raindrop save of that exact page, and the tags suggested from your Raindrop vocabulary. `keyword` rules match the article's top stems, so the key is a stem (`frigate`, not `frigates`; versions before 0.7.0 wrote the raw word, which never matched a plural). A `story` entry is bookkeeping for a thumb on one article (key = article id, value 1 or -1, 0 removes it); it has no effect on a score, is not listed as a rule, and its `keys` field lets a second press clear exactly the rules the thumb set, and only those whose value is still the one the thumb wrote. No new event type was added in 0.7.0, so a copy of Pravaha from before it still reads every event; it would list a `story` entry as an unknown rule.

## Derived state

- **Feed standing** = clamp(0.3 + sum of signals each multiplied by 0.5^(age / 14 days)). Signals: open +0.15, dwell over 15 seconds +0.10, read without opening or dismiss -0.05, save +0.25, unsave -0.25.
- **Interest profile.** A recency weighted mean of Raindrop bookmark vectors (half life 365 days), pruned to 500 terms. Each open pulls it at rate 0.05, each save at 0.12 and each thumbs up at 0.08. A thumbs down does not push the profile away.
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

`settings`, `cache` (articles, feeds, and `recent`), `bodies` (article HTML fetched on demand, trimmed with the cache), `icons` (feed icons as data URLs), `searchIndex`, `events`, `syncState`, `pendingOps` (Miniflux changes waiting to send), `raindropCache` (`{at, v: 2, bookmarks: [{title, excerpt, note, tags, domain, at, link}]}`; a copy without `v: 2` has no links and is fetched again at once), `echoLocal`, `enrichment`, `net`, `others`, `pendingHistory`. Dwell tracker state is kept in `storage.session` because the background page can unload.

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
- `treeOrderAt`: milliseconds of the last folder-order change on this machine or taken from Firefox Sync; compared with `order` events as described above.
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

Pulls happen at start-up and on every `storage.onChanged` for a `pv:` key. A machine that holds no key never writes any part (`push` returns `idle`). Every alarm poll and every time the reader tab becomes visible also runs a pull, because Firefox does not promise to wake an event page when Sync delivers data. Firefox itself sends extension data about every 10 minutes or at Sync Now. Taking keys starts a sync at once.

### Settings file

`{ format: "pravaha-settings", version: 1, exportedAt, from, settings, order, ui, keys, events? }`. `keys` is `null` or `{kdf: "PBKDF2-SHA256", iter: 250000, cipher: "AES-256-GCM", salt, iv, data}` (base64), sealing the same object as `pv:keys`. `events` is the event log, present only when the user ticked history; importing merges it by set union, so importing twice adds nothing. Files with a larger `version` are refused. The machine name is never read from the file.

### Messages added in 0.4.0

`profileSync` (summary of the four parts), `profilePull {force}`, `profilePush`, `exportSettings {keys, passphrase, history, ui}`, `importSettings {text, passphrase}`, `saveUi {ui}`. `status()` gains `scope` (`none`, `miniflux`, `full`), `imported` (`{at, events, devices}` after history arrives) and `nameClash`. `overall` is `off` when Miniflux is not configured.

## Miniflux calls

Read: `/me`, `/feeds`, `/categories`, `/entries` (with `status`, `starred`, `changed_after` and, for older articles, `search`), `/entries/{id}`, `/feeds/{id}/icon`. Write: `PUT /entries` (status, in chunks of 150), `PUT /entries/{id}/bookmark`, `GET /entries/{id}/fetch-content`. New in 0.3.0: `POST /discover` and `POST /feeds` and `POST /categories`, only when the user presses Find feeds, Subscribe or a new folder name.

## 0.6.0: server contract, light refresh, feed management

This section is written before the code. Where the Miniflux documentation (miniflux.app/docs/api.html, read in November 2026) is the only evidence for a behaviour, it says so. None of it has been run against a live Miniflux server; the capability record below is how Pravaha finds out on the first refresh and tells the reader.

### Local key `server` (never synced; each machine learns its own)

```
server: {
  version:   string | null,          // from GET /v1/version, e.g. "2.3.5"; null when the call failed or is unsupported
  checkedAt: ms | null,              // last time /version was tried; retried after 6 hours, or at once after a contract failure
  caps: {                            // what this server is known to support; every value is true, false or null (not yet known)
    version: bool|null,              // GET /version exists (documented since 2.0.49)
    entryIds: bool|null,             // GET /entries/ids (documented since 2.3.2): filters status, starred, offset, limit <= 10000 only
    afterEntryId: bool|null,         // GET /entries?after_entry_id (documented since 2.0.9)
    categoryRefresh: bool|null,      // PUT /categories/{id}/refresh (documented since 2.0.42; runs in the background)
    feedRefresh: bool|null           // PUT /feeds/{id}/refresh (synchronous, 204)
  },
  history: [ { v: string, at: ms } ],        // at most 5, newest last; a new entry is added whenever `version` changes
  changed: { from: string, to: string, at: ms } | null,   // set when the version differs from the last one seen; cleared by "Got it"
  contract: { ok: bool, at: ms, problems: [ { where, field, plain, count } ], skipped: int }   // at most 8 problems
}
```

Capability rules. A cap is `true` only after a call of that kind has succeeded with a well-shaped answer, and `false` only after the server answered 404 or 405, or a well-formed answer without the expected field. A network error or a 5xx never changes a cap. The version string is used only to explain a missing cap to the reader ("Miniflux 2.1.4 is older than 2.3.2, which added the list of entry numbers"); it never switches a feature on.

Contract rules. Each response that Pravaha uses is checked against a minimal shape before it touches the cache. Feeds need `id` (number), `title` (string) and `category.title` (string). Entries need `id`, `feed_id`, `status` (`read`, `unread` or `removed`) and `published_at` (parsable date); `title` and `content` may be empty. The entry number list needs `entry_ids` as an array of integers and `total` as a number. An item that fails is skipped, not guessed; the first eight distinct (where, field) pairs are kept in `contract.problems` with a count, and `contract.skipped` is the number of items dropped in the latest refresh. A refresh that skipped anything leaves the Miniflux lamp red, with the field named. It clears itself after a refresh with no failure.

Lamp. One new light, `server`, joins the status report: `off` when Miniflux is not set up; `red` when `contract.ok` is false; `amber` when `changed` is set and not yet acknowledged, or when the server is older than a feature Pravaha would otherwise use; `green` otherwise. It counts toward `overall`, so the top-bar pill, the toolbar badge and the Sync dashboard all show it. The toolbar badge is a single character on the extension button (`!` amber or red) and is removed when `overall` is green or off.

### Light refresh (replaces the full download when `caps.entryIds` is not `false`)

The old refresh downloaded every unread article body (up to 3,000) each time. The light refresh downloads ids and only the bodies Pravaha does not have.

1. `GET /feeds` as before.
2. `GET /entries/ids?status=unread&limit=10000`. If `total` exceeds the length of `entry_ids`, the list is incomplete and the old full path runs instead; nothing is marked read from an incomplete list.
3. New articles: `GET /entries?status=unread&after_entry_id=<highest id in cache>&order=id&direction=asc&limit=250`, paged until a short page. Ids in the list that are lower than the highest cached id and missing from the cache (an article marked unread again elsewhere) are fetched one by one with `GET /entries/{id}`, at most 40; more than 40 sends the refresh down the old full path.
4. Reconciliation. A cached unread article that is absent from the id list and is not pending, not recently sent, and not in a refresh window that began after the call started, is set to `read`. This is the same rule as before, with ids in place of bodies, so it also catches articles Miniflux deleted.
5. Stars: `GET /entries/ids?starred=true`; a cached article whose `starred` disagrees is corrected, and a starred id missing from the cache is fetched with `GET /entries/{id}`.
6. Changes elsewhere: `changed_after` as before.

The old full path remains, unchanged, as the fallback; `refresh` records `net.miniflux.mode` as `light` or `full` so the Sync page says which ran.

### Messages and Miniflux calls added

`serverState` (returns `server` plus the derived lamp), `serverAck` (clears `changed`), `serverCheck` (runs /version, the id list and a one-entry shape check without changing the cache, and returns plain sentences), `feedUpdate {id, title?, category?, disabled?}`, `feedDelete {id, confirm}`, `folderRename {id, to}`, `refreshScope {scope}`. Calls: `GET /version`, `GET /entries/ids`, `GET /entries?after_entry_id`, `PUT /feeds/{id}` (only the fields being changed), `DELETE /feeds/{id}`, `PUT /categories/{id}` (title), `PUT /feeds/{id}/refresh`, `PUT /categories/{id}/refresh`.

Feed management rules. These calls change the server and are never queued: if Miniflux cannot be reached, the action fails with a sentence and nothing changes locally. A successful call updates `cache.feeds` at once and the next refresh confirms it. Moving a feed to a folder that does not exist creates the category first. Renaming a folder renames the category with that title and every category whose title begins with `title/`, one call at a time; if one fails, the ones already renamed stay renamed, the sentence names them, and the feeds are re-read. Deleting a feed requires the exact feed title typed back; the engine checks it as well as the screen, and removes the feed's articles from the cache and the search index. Deleting a folder is not offered, because the Miniflux documentation does not say what happens to its feeds. Disabling a feed (`disabled: true`) is the reversible alternative and is what the screen suggests first.

Targeted refresh. `refreshScope` with `feed:<id>` calls `PUT /feeds/{id}/refresh`, then a light refresh. With `cat:<path>` it calls `PUT /categories/{id}/refresh` for the category and each sub-category (the call returns before the feeds finish), then schedules one light refresh after 6 seconds and another after 20. A 429 or a message about refreshing too often is shown as "Miniflux limits how often a feed can be refreshed".

### Schema changes to existing keys

`net.miniflux` gains `mode` (`light` | `full`), `calls` (requests made by the last refresh) and `bytes` (approximate size of the last refresh's responses). When the server's version number changes, `noteVersion` records `changed {from, to, at}` and sets every learned capability (`entryIds`, `afterEntryId`, `categoryRefresh`, `feedRefresh`) back to unknown, so each is learned again against the new server. `status()` gains `server`. No event types change, so the history log and Firefox Sync parts are untouched, and machines on 0.5.0 keep working with machines on 0.6.0.

## Raindrop context for an article (0.7.0)

The card asks the engine for `trainerFor(id)`: the article's tags (your own Raindrop tags first, then suggested ones, then the feed's, at most six), up to five title words with the stem each is trained as, the feed and author rules, and `raindrop: { configured, count, exact, related }`. `exact` is the saved page whose address matches the article's after both are reduced to one form (no scheme, no `www`, no fragment, no tracking parameters such as `utm_*`, `fbclid`, `gclid`, no trailing slash, remaining parameters sorted). `related` is up to two other saved pages whose text vectors have a cosine of at least 0.22 with the article. Nothing in it leaves the machine; the Raindrop copy is the one already kept for ranking.

Tag suggestion uses an index from each word to the tags whose profile contains it, built once per model, so an article is compared only with the tags it shares a word with. It gives the same tags, order and scores (to three decimals) as comparing every pair; a test checks this on random data.

A thumb on an article (`rateStory`) sets a rule of +/-0.3 on its top three tags (your own Raindrop tags first) and top three words. At 0.3 of a full click, six rules together stay under the scorer's 0.2 cap, so a tag clicked afterwards still moves the score.

## Digest additions (0.7.0)

Each of the top articles carries `saved in Raindrop` (exact match) or `close to your Raindrop save "title"` (closest related). A new section **What you trained** lists the tags, words, feeds and authors currently set to more and to less (twelve of each at most). The digest is still written weekly (`digests/<ISO week>.md`).

## 0.8.0: lighter storage, engagement-rate standing, hot stories

No event type was added and no key was renamed. Older copies read everything a 0.8.0 machine writes.

### Event `calibration` with `payload.kind: "exposure"`

`{ kind: "exposure", day: "YYYY-MM-DD", feeds: { "<feedId>": <articles published that UTC day> } }`. Each machine logs one per whole day it has not logged yet (the last three days at most), counted from its own article copy. Standing takes, per feed and day, the largest count any machine reported, so the result does not depend on which machine logged it or in what order the logs arrive. `calibration` has been a valid type since 0.1, and `derive` before 0.8.0 ignores it.

### Score (replaces the formula above)

```
final     = clamp( (wt*tag + we*echo + ws*standing + wf*freshness + wh*hot + training) * novelty )
weights   = tag 0.40, echo 0.20, standing 0.20, freshness 0.10, hot 0.10; a signal with no source (no echo data, no hot map) gets weight 0 and the rest are rescaled
tag       = 1 - exp(-3 * max(cosine with interest profile, best tag cosine))
best tag  = max over Raindrop tags with 2+ saves of cosine(article, tag profile) * n/(n+1)
echo      = 1 - exp(-3 * (cosine with echo vector + min(0.15, 0.05 * log2(1 + domain visits / 3))))
standing  = rate / (rate + m),  rate = (10*m + engaged) / (10 + trials),  m = your mean rate over all feeds (prior 0.05 over 50 trials)
            engaged per article = min(1, 0.25 card + 0.5 open + 0.25 dwell>15s + 1 saved), decayed from first touch (14-day half life)
            trials per feed = max(decayed exposure counts, decayed articles touched) + 1 per dismiss + 0.5 per read-without-open
hot       = ln(1 + k) / ln 6, k = other feeds whose article within 36 h shares 2+ of the top 8 terms and has cosine >= 0.35
freshness = 1 / (1 + (hours/24)^1.129), hours from published_at, but not later than created_at + 2 h; missing date = 24 h
training  = clamp(sum of rule values (each clamped to -3..3) * 0.08, -0.2, 0.2)
display   = 1.25s / (1.25s + 1 - s)
```

Interest profile: `(1 - L) * bookmark mean + L * weighted mean of pulls`, pull weights save 1, thumbs up 0.67, open 0.42, card 0.17, each decayed with a 60-day half life, `L = 0.3 * W / (W + 5)` where `W` is the total pull weight; pruned to 500 terms. Pulls carry their event time (`at`) in derived state.

### Local storage keys

| Key | Written | Meaning |
|---|---|---|
| `cache`, `events`, `searchIndex` | 1.2 s after a change, and only if the content differs from the last write; at once at the end of a sync | The heavy keys. A hash of the last written article copy is kept in memory, so an unchanged copy is never rewritten. |
| `eventsTail` | at once | This machine's events newer than the last full `events` write. Merged on load; emptied when `events` is written. |
| `marks` | at once | `{ feedsAt, lastChangeTs, outboxAt, outboxSig, exposureDay }`: when the feed list was last read, the Miniflux change cursor (moved out of `cache` so the copy does not change on every poll), the outside-scoring throttle, the last day whose article counts were logged. |
| `syncState` | at once | New fields: `dirsOk` (`root|device` whose WebDAV folders are known to exist), `stateSig` and `stateAt` (the state file is rewritten when its content changes or every 15 minutes), `listedAt` (the machine-folder listing is re-read every 30 minutes; between those, the state files name the machines). |
| `cache.items[id].seenAt` | with the article | Miniflux `created_at`: when the server first stored the entry. Used to distrust future publish dates. |
| `settings.weights.hot` | with settings | The fifth weight. A four-weight object from 0.7.0 gets the default. |

### Polling

- A quiet poll reads `/v1/feeds` at most every 15 minutes, or at once when an unread article names a feed not in the copy. A sync you start reads it every time.
- A light refresh no longer asks `changed_after`; read and saved state are reconciled by entry number.
- `enrich/results.json` is read and `enrich/outbox.json` written at most hourly, and the outbox only when its list of articles changed.
- A machine whose `state/<device>.json` says its `pushedSeq` is at or below what this machine already holds, with every earlier segment read whole, is not listed or downloaded.
- With no reader tab open, the background skips a poll if the last successful fetch is under 10 minutes old and nothing is waiting to be sent.
