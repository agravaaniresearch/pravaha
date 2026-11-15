# Changelog

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
