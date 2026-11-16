> Independent QA pass on 0.8.0 before release, in real Firefox 160 against fake servers with synthetic data. Every defect listed here was fixed before the signed build unless the CHANGELOG says otherwise. Paths refer to the tester's working folder.

# Pravaha 0.8.0: QA report

Tested 16 Nov 2026 on a copy of the working tree at commit c927944 (`/home/claude/qa/repo`), in real Firefox 160 (headless, Selenium with geckodriver) against local fake Miniflux, WebDAV and Raindrop servers. All data is synthetic. No real Miniflux, Fastmail or Raindrop server was contacted. The engineer's tree at `/home/claude/pravaha` was not touched.

QA tooling written for this pass (all in `/home/claude/qa`):

- `qserve.mjs` is a fake server with a richer library: 10 feeds, 72 entries, one story carried by 4 feeds and one carried by 2, long articles, two future-dated entries, and an empty-library mode. It also has controls for a Miniflux request that never answers, for wiping the WebDAV folders, and for a realistic `409 Conflict` on a PUT into a missing folder.
- `qa_ff.py` builds copies of the extension. It can instrument `background.js` (logs storage writes, alarm decisions, wake and suspend to the fake server) and can shorten `IDLE_POLL_MS`.
- The test scripts are `explore_ui.py`, `ui2.py`, `bg_test.py`, `reopen_test.py`, `persist_test.py`, `order_test.py`, `edge_test.py`, `empty_test.py`, `two_machine.py`, `two_mixed.py`, `contrast.py` and `node_two.mjs`.
- Logs are in `logs/` and screenshots in `shots/` (`ui`, `ui2`, `edge`, `e2e`, `s070`).

## Defects

I reproduced each defect below myself. The cosmetic opinions are listed separately.

| # | Sev | Area | Repro steps | Expected | Actual | Evidence |
|---|---|---|---|---|---|---|
| 1 | Medium | Storage (regression from 0.7.0) | (1) Set up one profile with pollMinutes 30. (2) Reorder the top-level folders (drag, Alt+arrow, menu Move up, or the `reorderFolders` message). (3) Do nothing else until Firefox unloads the event page (about 30 s idle). (4) Read `storage.local` from `popup.html`. | The `order` history event is in `events` or `eventsTail`, as every other event now is. | It is in neither. The in-memory history count went from 4 to 3 plus the next event, and the next event (a `train`) took the same sequence number (`…:4`). The cause is in `setOrder()` (`engine.js` around line 563): it appends an `order` event but persists only through `saveSettings()`, which in 0.8.0 writes `["settings"]` only. In 0.7.0 `persist()` with no list also wrote `events`. The local order survives (`treeOrder` in settings) and Firefox Sync still carries it. The WebDAV history copy is lost, so a machine that relies on the WebDAV log, the settings-file history or a later re-import never gets that reorder. | `logs/order_test.txt` |
| 2 | Medium | Split pane, keyboard (new feature) | (1) Use a window 1800 px or wider. (2) Open a long article (row 1). (3) Press PageDown, Space or ArrowDown. | The article in the reading pane scrolls, as it does with the wheel. | The list behind it scrolls instead (page `scrollY` went 0 → 866 → 1732 → 1789, pane `scrollTop` stayed at 0). Only the mouse wheel over the pane scrolls the article (`scrollTop` 800 of 2514). A keyboard-driven reader cannot read a long article in the pane without the mouse. | `logs/ui2b.txt`, `shots/ui2/why-2560.png` |
| 3 | Low | Themes and palette | (1) Settings > Look: choose Light, then Ember. (2) Click the toolbar theme button 7 times. | Coming back to Light, Dark or OLED restores their own palette (ember), or the earlier choice. | The sequence is khadi/sindoor → dark/**sindoor** → jamun/kesar → lacquer/jade → oled/**jade** → auto/jade → light/**jade**. Choosing Light from the Look tab after Khadi also keeps sindoor. `themePatch()` sets a palette only for the three new themes. | `logs/explore_ui.txt` (last line and the "2560 theme light" line) |
| 4 | Low | Unit tests | Run `npm test`. | All tests pass. | 254 pass, **1 fail**, 2 skipped. `test/v050.test.mjs:84` still asserts `m.version === "0.7.0"`, so it is a stale assertion and not a product bug. The CI release workflow would go red. | `logs/npm-test.txt` |
| 5 | Low | Accessibility (Khadi) | Use the Khadi theme on a row whose story is covered by several feeds. | The "N feeds" chip text is at least 4.5:1 (it is about 12 px bold). | `--on-accent #fff8f2` on the chip background (accent 85% over the surface, ≈ #cf533b) is **4.03:1**. Every other theme's chip is 6.8 to 7.6:1. | `contrast.py` output; `shots/ui/feed-khadi-1440.png` |
| 6 | Low | Ranking explanation | Open a hot article (row 1, carried by 4 feeds) and expand "Why it ranks here". | Each weighted part of the score has a bar, including the new "Covered by several feeds" (Settings > Ranking has five sliders). | Only 4 bars appear (Tag match, Sites you read, Feed standing, Freshness). The hot component (weight 0.10 by default) is invisible, so the bars do not add up to the score. | `logs/ui2b.txt` ("why bars"), `shots/ui2/why-2560.png` |
| 7 | Low | Future-dated entries | Use a feed entry dated 3 days ahead that Miniflux stored 1 hour ago (`created_at`). | The age shown uses the same guard as the score (stored 1 hour ago). | The ranking guard works: freshness is 0.972, taken from the stored time. The row and card show "1m" and "1 minute ago" with a "New" chip, because `ago()` clamps negative ages. In feed-grouped view the future item stays first in its section until the date passes. | `logs/edge_test.txt`, `shots/edge/future-dated.png` |
| 8 | Low | WebDAV recovery | (1) Sync successfully. (2) Delete every folder on the WebDAV server. (3) Sync with nothing new to send. | Folders and this machine's state file are recreated, or the loss is reported. | The light stays green ("Reachable. Last sync just now") and nothing is recreated. The state file stays missing, so the other machine cannot see this one for up to 15 minutes or until something new is written. When a new event is written, the first sync fails red (409 on the PUT) and the second recreates all folders and succeeds, which meets the brief's requirement. | `logs/edge_test.txt` |
| 9 | Low | Documentation | Read `docs/SCHEMA.md`, `CHANGELOG.md` and the README "What has not been verified" section. | The new storage keys and the 0.8.0 changes are documented. | `SCHEMA.md` (storage list, line 65) lacks `eventsTail` and `marks`, and the new `syncState` fields (`dirsOk`, `stateSig`, `stateAt`, `listedAt`) and the `calibration`/exposure payload shape are not described. `CHANGELOG.md` has no 0.8.0 entry, and the README's "not verified" list says nothing about 0.8.0. | the files themselves |

### Pre-existing behaviour found while testing 0.8.0 (also present in 0.7.0)

- **Every event-page wake re-arms the poll alarm with a 12 s delay.** `ready` calls `schedule()`, which clears the `poll` alarm and creates it again with `delayInMinutes: 0.2`. Firefox 160 unloads the background page about 30 s after it goes idle, even with the reader open, so each wake gives a second poll 12 s later. With pollMinutes 1 and the reader open, I logged polls at 49:51, 50:03, 51:03, 51:15, and so on: about 1.7 light polls a minute instead of 1. With the reader closed the extra alarms are cheap skips. This was not introduced in 0.8.0, but it works against 0.8.0's lighter-poll goal. Evidence: `logs/bg_test.txt`.
- **"Sync now" during a running sync returns at once and does not queue another.** In the two-machine run, A's `syncNow` returned the status of an older sync, and B's training arrived about 3 s later. The new sync-on-open makes this collision a little more likely, since opening the reader and then pressing `r` hits it. Evidence: `logs/two_machine2.txt`.
- **The "N unread in total" header does not drop when a card is opened,** while the sidebar and tab badge do. The same happens in 0.7.0. Evidence: `logs/ui2b.txt`, `logs/ui2_070.txt`.
- **Score badge contrast.** The white-or-dark text rule in `gradeColor` gives 2.2 to 2.7:1 at mid scores in every palette, old and new (worst is jade at 2.22).

### Cosmetic opinions (not defects)

- On the open row, the chips (including the new "N feeds" chip and tags) are hidden at every width, even at ultrawide where the row's title and summary come back.
- Between 1800 and about 2100 px the list column is narrow (632 px at 1800), and the sticky toolbar wraps to two rows (`shots/ui2/pane-1800.png`). In headless screenshots the list text shows through the translucent sticky bars. Headless rendering of `backdrop-filter` may be the cause, so I did not count it.
- An empty library says "You are all caught up" on a server with no feeds at all.
- The Sync page at 2560 uses about half the width. It is not squeezed, and there is no sideways scroll.

## What passed

**Step 1: Node suites**
- `npm test`: 257 tests, 254 pass, 1 fail (#4), 2 skipped. The two skips are the "old 0.7.0 code" comparisons. The skip at `scoring.test.mjs:184` also skips its new-path assertions, but test 256 covers designators.
- `npm run lint`: 0 errors, 0 warnings, 0 notices.
- `node tools/failure-rates.mjs 40` ran in 16 s with 0% unhandled errors in every table, at 0, 5, 20 and 50% request failure.
  - Light refresh: 0% divergence after recovery, and 100% of last refreshes were the light kind.
  - Training: both machines held the same training and ranking in 100% of trials.
  - Two-machine convergence: 100%, with 0 lost reads and 2.00 average recovery passes.
  - Folder rename: never claimed success while Miniflux disagreed.
- `node tools/bench-lightness.mjs`, where KB written is local storage:

| Case | Time | Calls | Network | Writes | Written |
|---|---|---|---|---|---|
| Idle poll after a wake | 152 ms | 5 | 19 KB | 2 | 1 KB |
| Idle poll, page awake | 24 ms | 3 | 14 KB | 2 | 2 KB |
| Open a card and redraw | 88 ms | n/a | n/a | 2 | 1 KB |

  The same run gave model build 153 ms, and a 3,000-row list 358 ms (55 ms the second time).

**Step 2: existing real-Firefox suites against the 0.8.0 copy.** Each suite ran on a freshly started `serve.mjs`.
- `e2e.py`: 32 of 32 pass, including history import, Firefox Sync arrival, the settings file with passphrase, no overflow at 2370 px, and idle polls that do not flash.
- `e2e050.py`: 44 of 44 pass at 2370 and 1360 px (drag, menu, overflow on every Sync and Settings tab, feed detection).
- `e2e060.py`: 12 of 12 pass on the normal library and 13 of 13 on BIG=30x14 (420 groups, 1,260 rows).
- `shots070.py` with WITH_APPLE=1: 9 of 9 pass. The fonts loaded were Pravaha SF Pro (normal and italic) and Pravaha New York.
- `perf_calls.py` (BIG): view of all unread 82 ms, ranked view 78 ms, payload 883 KB.
- `probe_flash.py` (60 s per page): Newsfeed showed 0 mutations and 0 toasts. The Settings pages showed 4 mutations and 0 toasts.
- None of these scripts hard-codes idle-poll call counts, so 0.8.0's intended changes caused no false failures.

**Step 3: exploratory UI** (`shots/ui`, `shots/ui2`)
- **Themes.** All six themes were screenshotted at 1440x900 and 2560x1080, with no sideways scroll at either width. Each theme sets the right `data-theme`, and Khadi, Jamun and Lacquer take sindoor, kesar and jade.
- **Contrast.** Every `--text` and `--muted` pair on `--bg`, `--surface`, `--raised` and `--hover` is at least 4.5:1 in all themes. The lowest is Khadi `--muted` on `--raised` at 5.04. The new themes' text is 13.6 to 16.2:1. `--accent-ink` is 6.2 to 11.0:1.
- **Split pane.** At 2560 the pane is fixed at 1508 px, 1040 px wide, top 52 px. It stays put and receives clicks after the list is scrolled 2,500 and 5,000 px. It switches on exactly at 1800 px (1799 stays inline) and also works at 1920. Below 1800 the card opens inline, and the row's duplicate title and summary are hidden.
- **Keyboard.** `j` and `k` with a card open move the open card at both widths. `o` opens and a second `o` closes. Esc closes it cleanly with no inline flash (`esc-closing-2560.png`). The card's Close button works.
- **Empty-state pane.** It shows its two-line text at 2560 and is absent at 1440, on the Saved, Stats and Sync tabs, and in an empty library.
- **Read on scroll with the pane.** It marked 17 rows read while the pane stayed open on its article.
- **Ranking tab.** It shows five sliders, including "Covered by several feeds".
- **Hot chip.** Rows carried by 4 feeds show "4 feeds" with a correct tooltip. The 2-feed pair also shows a chip.
- **Other pages.** Stats, Sync and Saved at 2560 have no sideways scroll and no pane padding (the right padding is 28 px). The help overlay and the "Mark all read" dialog sit above the pane.
- **Console errors.** The error hook loaded before `reader.js` caught 0 page errors across all runs. The only Firefox-log item from the extension was a slow-script warning in `updateBadge`, logged after Marionette had already stopped (a shutdown artifact).

**Step 4: background behaviour in real Firefox 160** (instrumented copy, `IDLE_POLL_MS` set to 3 minutes)
- **readerOpen detection.** `extension.getViews({type:"tab"})` works in the MV3 event page. With the reader open the log reads `readerOpen=true views=/ui/reader.html` and the poll syncs. With it closed it reads `readerOpen=false views=` and the poll skips while the last success is newer than the threshold. I saw skips at 64, 124, 136, 144 and 156 s, then a sync at 196 s and again at 216 s.
- **Sync on reopen.** Opening the reader after 150 s quiet synced at once (`reopen_test.txt`).
- **Storage writes on idle polls.** Writes were only `marks,net,pendingOps,server` and `enrichment,marks,net,others,pendingHistory,pendingOps,server,syncState`, about 0.6 KB and 1 KB. `cache`, `events` and `searchIndex` were never written by an idle poll. Skipped polls write nothing.
- **Suspend.** `runtime.onSuspend` fires in Firefox 160; it was logged twice.
- **Deferred write.** I opened an article, waited 3 s and called `runtime.reload()`. The `card` event was in `events` and the status was read.
- **Harsh case.** I reloaded 150 ms after opening while Miniflux hung. The `card` event survived in `eventsTail` and the status operation in `pendingOps`. The cached read state was lost, as designed, and was restored by the next sync: the server and the cache were both read.

**Step 5: two machines in two profiles, WebDAV only** (no Firefox Sync copying)
- History (dismissals), training (add, later add, clear) and folder order all converged in both directions. Both machines ranked the unread list the same (60 of 60).
- Three quiet rounds on two machines made 12 WebDAV calls, with 0 segment GETs, 0 PUTs and 0 MKCOL.
- Changes made after the quiet rounds still arrived on the next round, so the skip logic does not go stale.
- A 0.8.0 machine paired with a 0.7.0 machine converged on history, training and order. The ranking and call counts differ, as expected between the two engines.

**Step 6: edge cases**
- **Hung Miniflux request.** The pill showed "Reading from Miniflux" for about 30 s, then the reader recovered with a red light and a plain timeout sentence. The progress bar cleared. The next sync ran normally in 0.1 s, and the lock was released.
- **WebDAV 409 after folder deletion.** The next sync that writes recreates all folders and succeeds (see #8 for the quiet case).
- **Empty library.** No errors, no overflow, no pane, and all lights green.
- **Future dates.** The ranking guard works (see #7 for the display).

## What I could not test, and why

- **Real servers.** Miniflux, Fastmail WebDAV and Raindrop are out of scope by instruction. Fastmail's real 409 and 404 behaviour after a folder deletion is modelled on the WebDAV spec.
- **Zen itself, and headed Firefox.** All runs were headless Firefox 160, so `backdrop-filter` rendering, true scrollbar widths and HiDPI on the 2560x1080 monitor were not seen.
- **The real 10-minute idle threshold.** It was shortened to 3 minutes. The logic is the same, but the real wall-clock value was not run.
- **The real Firefox Sync cloud.** It was simulated, or not used.
- **Restarting the browser with the same profile.** Temporary add-ons are removed on exit, so persistence was checked through `runtime.reload()` instead.
- **A WebDAV request that hangs.** The fake can only hang Miniflux requests. The 60 s WebDAV deadline is covered by unit tests only.
- **Long-running profile behaviour,** such as daily `calibration` exposure accumulation over weeks.

## Release recommendation

Ship 0.8.0 after two small fixes.

1. Fix #1 by persisting `events` when `setOrder` appends, for example `persist(["settings", "events"])` in that path.
2. Fix #4 by updating the version assertion.

I recommend fixing #2 (keyboard scrolling of the pane) before the user relies on the ultrawide layout, because his workflow is keyboard-driven, but it is not a blocker. The remaining items are Low and can follow in 0.8.1. The 0.8.0 core goals held in real Firefox: deadlines, lighter polls, idle skipping, deferred writes, and two-machine convergence with the skip logic.
