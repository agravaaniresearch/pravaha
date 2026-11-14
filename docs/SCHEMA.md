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

`settings`, `cache` (articles and feeds), `bodies` (article HTML fetched on demand, trimmed with the cache), `icons` (feed icons as data URLs), `events`, `syncState`, `pendingOps` (Miniflux changes waiting to send), `raindropCache`, `echoLocal`, `enrichment`, `net`, `others`, `pendingHistory`. Dwell tracker state is kept in `storage.session` because the background page can unload.


Interface preferences (theme, palette, density, thumbnails, read on scroll, reading type, anchor bolding and strength) and collapsed feeds live in the reader page's `localStorage` under `pravaha.ui` and `pravaha.collapsed`. They stay on the machine and are not synced.

Bundled fonts, all under the SIL Open Font Licence (licences are in `extension/ui/fonts/`): IBM Plex Sans for the interface, Newsreader and Literata for reading.
