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

- Firefox will ask to approve one new permission, **menus**, for the right-click item "Find feeds here with Pravaha". It cannot read pages.
- The first refresh builds the search index from the articles already cached. Articles read before the update are findable only while they remain in the cache; the index keeps them for 400 days from then on.
- The first bulk mark-read afterwards does a check against Miniflux, which fetches the unread list once more than before. On a very large unread backlog that is a few extra requests.
- Nothing in WebDAV changes. The event log, state files and digests are unchanged, so 0.2.x and 0.3.0 can run on two machines at once.

To go back, install the older `.xpi` over this one. The extra storage keys (`searchIndex`, `cache.recent`, `settings.treeOrder`) are ignored by older versions.

## 5c. Optional: SF Pro and New York (your own build only)

Apple's fonts are not in the repository. To use them yourself: `pip install fonttools brotli`, `python3 tools/apple-fonts.py`, then build and sign as usual from the same checkout. The files land in `extension/ui/fonts/apple/`, which is git-ignored, so they stay out of commits. The signed build from the GitHub release workflow will not contain them (the picker will show "Not in this build"); sign locally if you want them. Do not share an extension built this way.

## 6. Backups and recovery

- Miniflux holds the read state and stars. Export OPML from Miniflux for the feeds.
- The WebDAV folder holds the full event history. Back it up like any other folder.
- To start the ranking over, delete the `events` folder in WebDAV and clear the extension's storage. Miniflux is untouched.
- If a machine is lost, install on a new one with a new name. It rebuilds everything from Miniflux, Raindrop and the event log.


## 7. Testing in real Firefox

`tools/firefox-e2e/` drives two or three real Firefox profiles with Selenium against a fake Miniflux and WebDAV. Needs Firefox (160 tested; Zen is built on it) and geckodriver under `/home/claude/ffx` (or set `FFX`), `pip install selenium`, and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (set by the script) so Marionette may open extension pages. Run `node tools/firefox-e2e/serve.mjs 8799 &` then `python3 tools/firefox-e2e/e2e.py`. Firefox Sync's cloud is not reachable there, so delivery is simulated by copying the `storage.sync` items between profiles.
