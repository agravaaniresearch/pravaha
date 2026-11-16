# Deploying Pravaha

## 1. What you need

- A Miniflux account on a hosted or self-hosted server, and an API key (Miniflux, Settings, API Keys).
- A Fastmail account with Files and WebDAV, and an app password for it (Fastmail, Settings, Privacy and Security, App passwords, with access to Files).
- Optional: a Raindrop test token (Raindrop, Settings, Integrations, For Developers, create an app, then create a test token).
- Firefox 140 or later on each machine.

## 2. Put the code on GitHub

1. Create a repository and push this folder to it.
2. In the repository, open Settings, Secrets and variables, Actions, and add two secrets: `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. These are the API key and secret from addons.mozilla.org (Tools, Manage API Keys).
3. Push to `main`. The workflow runs the tests, the linter and the failure harness, sets the version patch to the run number, signs the add-on on the unlisted channel and publishes `pravaha.xpi` as a release.

Without the two secrets the workflow still builds, but the result is unsigned and uploaded as a workflow artifact only. Regular Firefox will not install it.

Rotate the AMO keys if they have ever been pasted into a chat, an issue or a log. Generate a new pair on addons.mozilla.org and update the two secrets.

## 3. Install on each machine

1. Download `pravaha.xpi` from the latest release.
2. In Firefox, open `about:addons`, click the gear icon and choose Install Add-on From File.
3. Pin the Pravaha button if you like. Alt+Shift+R also opens the reader.

Updates: Firefox does not auto-update a self-distributed add-on unless the manifest carries an update URL. Install the new release over the old one. Your data stays, because it lives in extension storage and on WebDAV.

## 4. First-time setup

Open Settings in the reader.

1. **Miniflux.** Enter the server address and API key. Press Save, then Test Miniflux on the Sync page.
2. **WebDAV.** Enter `https://myfiles.fastmail.com`, your Fastmail user name, the app password and a folder name such as `pravaha`.
3. **Machine name.** Give each machine a different name, for example `laptop` and `desktop`. Choose it once and keep it. Changing it later starts a fresh sync position, and events not yet sent under the old name stay on that machine only.
4. **Raindrop.** Paste the token if you want tag suggestions and one-way saving.
5. **Custom servers.** If your Miniflux or WebDAV address is not the default, Firefox asks for permission to reach it when you press Save. Accept.

## 4b. Setting up a second machine (0.4.0)

A machine with no keys shows "Set up this machine" at the top of Settings with three routes. Everything arrives in the same order: keys, then articles from Miniflux, then reading history from the WebDAV storage (the toast and the Sync page show how many events were read).

1. **Firefox Sync.** On the first machine open Settings, Move setup and press Send (it also sends by itself). On the new machine sign in to Firefox Sync with Add-ons ticked (Mozilla documents this as required for any extension's synced storage), install Pravaha, and wait. Firefox sends extension data about every 10 minutes, so for an immediate result choose Sync Now in Firefox (the account icon, or Settings, Sync) on the sending machine first and then on the receiving machine. Pravaha looks at Firefox Sync's storage at every poll and whenever the reader tab comes to the front; Check Firefox Sync now looks at once. On the Move setup tab, "Written on this machine" means Firefox has not yet sent that part, and "Arrived" means it came from another machine. Keys, settings, folder order and look arrive; the machine name does not.
2. **Settings file.** Settings, Move setup, Export. Tick keys and choose a passphrase if you want the keys in the file; tick history to carry it in the file too. On the new machine choose Import and enter the passphrase.
3. **Copy as text.** Settings, Move setup, tick keys, choose a passphrase and press Copy as text instead. Send the text to yourself (a note or a message), then paste it under Import on the new machine. This route needs no Firefox Sync and leaves out the reading history, which arrives from WebDAV once the keys are in.
4. **Type the keys** as in step 4.

Give each machine its own name. A new install gets a name like `browser-k3x9a`; rename it in Settings, This machine, before the first sync if you prefer. If two installs share a name, the second stops with a plain message and writes nothing.

If you update a machine that still has the old default name `this-machine` and has already written history, keep that name on that machine and rename only the new ones.

## 5. Obsidian and Grok

- **Obsidian.** Point your vault's sync at the `digests` folder inside the WebDAV folder. One Markdown file appears per ISO week.
- **Grok or another assistant.** Pravaha writes `enrich/outbox.json` with borderline articles. An automation can write `enrich/results.json` in the documented shape (see SCHEMA.md). The reader blends it in at its next sync. Nothing leaves your storage unless your own automation sends it.

## 5b. Updating from 0.2.x to 0.3.0

Install the new `.xpi` over the old one, as in step 3. Settings, history and the saved order stay. What is new on first start:

- Firefox will ask to approve one new permission, **menus**, for the right-click item "Subscribe with Pravaha" (renamed in 0.5.0). It cannot read pages.
- The first refresh builds the search index from the articles already cached. Articles read before the update are findable only while they remain in the cache; the index keeps them for 400 days from then on.
- The first bulk mark-read afterwards does a check against Miniflux, which fetches the unread list once more than before. On a very large unread backlog that is a few extra requests.
- Nothing in WebDAV changes. The event log, state files and digests are unchanged, so 0.2.x and 0.3.0 can run on two machines at once.

To go back, install the older `.xpi` over this one. The extra storage keys (`searchIndex`, `cache.recent`, `settings.treeOrder`) are ignored by older versions.

## 5c. Optional: SF Pro and New York (your own build only)

From 0.7.0 these two Apple fonts are the only fonts Pravaha carries (SF Pro for the interface, New York for reading); the open fonts were removed. Apple's fonts are not in the repository. To use them yourself: `pip install fonttools brotli`, `python3 tools/apple-fonts.py`, then build and sign as usual from the same checkout. The files land in `extension/ui/fonts/apple/`, which is git-ignored, so they stay out of commits. The signed build from the GitHub release workflow will not contain them: the picker will show "Not in this build" and the reader falls back to your system serif and sans. Sign locally if you want them. Do not share an extension built this way.

## 6. Backups and recovery

- Miniflux holds the read state and stars. Export OPML from Miniflux for the feeds.
- The WebDAV folder holds the full event history. Back it up like any other folder.
- To start the ranking over, delete the `events` folder in WebDAV and clear the extension's storage. Miniflux is untouched.
- If a machine is lost, install on a new one with a new name. It rebuilds everything from Miniflux, Raindrop and the event log.


## 6b. Updating to 0.5.0

Update every machine to 0.5.0 before using folder drag-and-drop on any of them: an older version counts the new `order` lines in the history as invalid (they are skipped and reported, nothing is lost). The toolbar icon, the popup and the "Subscribe with Pravaha" item need no setup. Feed detection is optional: Settings, This machine, "Detect feeds on pages". Firefox asks once for permission to run on all websites; saying no changes nothing else.

## 6c. Updating to 0.6.0

Nothing needs doing on the storage; no event type changed. Install the new file on each machine. Firefox asks for no new permission.

1. Open Sync. The new **Miniflux server** tile shows the version. Press **Check server**: it reads only. Lines marked amber mean a newer Miniflux call is missing on your server, and Pravaha keeps using the older path for that part.
2. A red tile or a red "!" on the toolbar button means Miniflux answered in a shape Pravaha does not recognise. Nothing wrong is saved; the sentence names the field. Send that sentence along when reporting it.
3. After a Miniflux upgrade the tile turns amber and says the version changed. Look through your feeds, then press **Got it**.
4. Feed changes (Settings, Feeds, or right-click) are written to Miniflux first. A folder rename is several requests; if one fails the message says which were done.
5. Folder refresh and Refresh every feed ask Miniflux to fetch in the background, so new articles appear within a minute. Miniflux may refuse refreshes that come too often; Pravaha then says so.

`e2e060.py` (0.6.0) drives the Feeds tab, the folder menu, the server tile and Check server, and a large library, in real Firefox. `perf_drag.py`, `perf_view.py` and `perf_calls.py` print the numbers in CHANGELOG.md. Start the fake servers first with `BIG=30x14 node tools/firefox-e2e/serve.mjs 8799` (restart them before every run).

## 6d. Updating to 0.7.0

No change to the storage and no new event type. Install the new file on each machine; Firefox asks for no new permission. Machines on 0.5.0 or later keep working side by side; one still on an older build will list a thumb's bookkeeping as an odd rule but nothing breaks.

1. Settings, Look and reading now offers only New York, SF Pro and the system fonts. A saved choice of any other font falls back to New York (reading) or SF Pro (interface) by itself. If you build the signed file yourself, run `python3 tools/apple-fonts.py` first, or the fonts will fall back to the system ones.
2. Open an article. Under the buttons there is a **Tags** and **Words** strip. Click a chip once for more of it, again for less, a third time to clear. The thumbs (or `+` and `-`) train on the top three tags and words together; press again to take it back.
3. If you use Raindrop, the first sync after the update fetches your saves again (the copy now keeps each link). Until that finishes the card cannot say "You saved this page".
4. The weekly digest has a new **What you trained** section, and notes articles you already saved in Raindrop.
5. Training on tags needs your Raindrop tags to suggest from. Without a token the strip says so and still offers words.

`shots070.py` drives the thumbs, the strip and the Raindrop line in real Firefox against a fake Raindrop (`serve.mjs` serves it under `/rd`; `ff.py` points the copy under test there, never at the real Raindrop). `WITH_APPLE=1` includes the Apple fonts in that copy. `node tools/failure-rates.mjs 150 --write` regenerates `docs/FAILURE_RATES.md`, which now includes the training trials.

## 6e. Updating to 0.8.0

No event type was added and no stored key was renamed. Install the new file on each machine; Firefox asks for no new permission.

1. **New signing keys.** 0.8.0 was signed with a new pair of AMO keys. For the GitHub workflow to sign the next builds, replace both repository secrets (Settings, Secrets and variables, Actions): `AMO_JWT_ISSUER` (the `user:...` value) and `AMO_JWT_SECRET`. The workflow cannot read them from anywhere else, and this cannot be done from outside the repository settings.
2. **The first sync after the update** records how many articles each feed published on each of the last three days. Feed standing uses these counts, so it settles over the first few days; until then it is worked out from the articles you touched. Scores are higher overall than in 0.7.0, so the colours look warmer. Nothing needs resetting.
3. **The Ranking tab** has a fifth slider, "Covered by several feeds". Saved weights from 0.7.0 keep their values and the new one starts at 10 percent.
4. **Themes:** the theme button now cycles through seven. Khadi, Jamun and Lacquer also switch the relevance colours to their own palette; change it back under Look and reading if you prefer.
5. **Wide screens:** at 1800 pixels or wider the open article reads in a pane on the right. Narrow the window, or close the sidebar, if you prefer the card inside the list.
6. **Quieter when closed:** with no Pravaha tab open, polls run at most every 10 minutes. Opening the reader fetches at once if the last fetch is older than your poll interval.
7. Building the signed file yourself: run `python3 tools/apple-fonts.py` first (it needs `pip install fonttools brotli` and clones a large font collection), then `npx web-ext sign --source-dir extension --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"`. The version in `extension/manifest.json` must be new to AMO.

`node tools/bench-lightness.mjs` prints what an idle poll and a card open cost on a synthetic library.

## 6f. Updating to 0.8.1

Install the new file on each machine; no permission is asked. On first start Pravaha switches its own Raindrop save off once (Miniflux's integration saves into "MiniFlux Saves" instead); turn it back on under Settings if you want both. The Raindrop copy is read again at once, to learn which collection each save is in. The Extension health tile is on the Sync page.

## 7. Testing in real Firefox

`tools/firefox-e2e/` drives two or three real Firefox profiles with Selenium against a fake Miniflux and WebDAV. Needs Firefox (160 tested; Zen is built on it) and geckodriver under `/home/claude/ffx` (or set `FFX`), `pip install selenium`, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (set by the script) so Marionette may open extension pages. Run `node tools/firefox-e2e/serve.mjs 8799 &` then `python3 tools/firefox-e2e/e2e.py`. `tools/firefox-e2e/probe_flash.py` runs two active machines for a few minutes and counts toasts and redraws while idle. Firefox Sync's cloud is not reachable there, so delivery is simulated by copying the `storage.sync` items between profiles.

`e2e050.py` (0.5.0) drags a folder with real pointer input, opens the right-click menu, scans the Sync and Settings tabs at 2370 and 1360 pixels for sideways scrolling, and turns feed detection on and off against a page served on port 8801. It sets `extensions.webextOptionalPermissionPrompts` to false so Firefox's permission prompt does not block the run. `shots050.py` takes the page screenshots.
