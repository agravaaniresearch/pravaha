# Policy and risk review

This is a design review of a personal tool, not legal advice.

## Data and privacy

- **No telemetry.** The manifest declares that the extension collects no data. Nothing is sent to the author or any analytics service.
- **Where data goes.** Only to servers the user configures: their Miniflux, their Fastmail WebDAV and Raindrop (api.raindrop.io). Article text stays in Miniflux and the local cache.
- **Browsing history.** History and bookmarks are read locally to build the echo profile. Only a term vector and domain counts leave the machine, and only to the user's own WebDAV folder. Page URLs and titles of visited pages are not uploaded.
- **Credentials.** The Miniflux key, WebDAV app password and Raindrop token are stored in the extension's local storage, which Firefox keeps unencrypted in the profile folder. Anyone with access to the profile can read them. Use a Fastmail app password limited to Files, and a Miniflux key you can revoke. Syncing keys through Firefox Sync is optional and off by default.
- **Outside scoring.** `enrich/outbox.json` holds titles, summaries and links of borderline articles and the top terms of the interest profile. If the user connects an outside assistant, those leave the user's storage. Turning this on is the user's decision, and the file contains no credentials.

- **Thumbnails and images.** When thumbnails or article images are shown, the browser loads them from the publisher's site, which reveals the user's IP address to that site. Thumbnails can be turned off in Settings. Feed icons come from Miniflux, not from publishers.

- **Fonts.** Eight reading faces and four interface faces are bundled, so no font is fetched from the web at read time. Their licence files are in `extension/ui/fonts/`.
- **Bundled code.** `extension/vendor/bionify.mjs` carries the word rules of Bionify (GPL-3.0, licence file alongside), with the delivery changed so it builds DOM nodes instead of assigning HTML. It runs locally on text nodes of already sanitised content and makes no network calls. Because it includes GPL-3.0 code, Pravaha as a whole is distributed under GPL-3.0: anyone who receives the add-on is entitled to the source, which the source zip provides. The name "Bionic Reading" is a registered mark of its owner, so the interface calls the setting "Anchor bolding".

- **Feed discovery and subscribing.** The Add feed dialog sends the address the user typed to the user's own Miniflux (`POST /discover`), and Miniflux's server then fetches that page. The extension does not contact the site itself, so the site sees Miniflux's address and not the reader's. The right-click item "Find feeds here with Pravaha" passes only the address of the page or link that was clicked, and only after the click; the extension has no content script and does not read pages. Subscribing and creating a folder are written to Miniflux only when the user presses the button. Feed addresses from the discovery reply are accepted only if they begin with `http://` or `https://`.
- **Search index.** The search index holds titles, feed names, tags, short summaries and a few keywords for articles read in the last 400 days, on this machine only. It is not uploaded. It extends how long the reader remembers what was read: an article read months ago stays findable after its text is gone from the reading cache. It can be cleared by removing the extension's data. It stores nothing that Miniflux does not already hold.
- **Older-article search.** The "Search Miniflux for older" button sends the user's search words to the user's own Miniflux. Operators such as `#tag` and `in:read` are removed before sending.

## Third-party terms

- **Miniflux.** Uses the documented REST API with a personal API key. Polling is every two minutes by default against the user's own account, which is within normal use for a hosted account. Raise the interval if the host asks.
- **Raindrop.** Uses the official REST API with a personal test token. Reading is paged and cached for a day. Saving is one way. The claim that Raindrop generates tags with a local model is unconfirmed, so Pravaha does its own local tag matching instead.
- **Fastmail.** Uses WebDAV with an app password, as Fastmail documents for Files.
- **Mozilla.** Distributed as a self-signed (unlisted) add-on, which Mozilla's terms allow. It is not listed on addons.mozilla.org, so it does not go through listed-add-on review.
- **Publishers.** Pravaha shows Miniflux's own content and links out to the original page. It does not bypass paywalls and does not scrape. The full-article button asks Miniflux to fetch the page, using Miniflux's own content fetcher from the user's own server, only when the user presses it. Pravaha never requests the publisher's page itself.

## Behavioural risks of the 0.3.0 actions

- **Bulk mark-read is the one action that can hide a lot at once.** It asks for confirmation by default for a section, a folder and "mark all", and says how many articles it will touch. The result message offers Undo, which puts exactly those articles back as unread in Miniflux. A single article never asks unless the user turns on "Always ask". Scrolling past an article never asks, because it is automatic and affects only that article.
- **The reader does not claim success it did not get.** After a bulk mark it asks Miniflux which articles are still unread and sends those again, up to three rounds. If some still did not stick, the message says how many and that they will be retried. The 10 minute re-send window can, at worst, mark read again an article that the user marked unread on another machine within that window; it gives up after three tries.
- **Marking by scope reaches articles that are not on screen**, because the section or folder is the unit, not the visible rows. That is the intended fix, and the confirmation states the real count (for example "Mark 312 articles in Naval Wire as read") so it cannot be a surprise.
- **Reordering** changes only the order shown here. It never renames or moves anything in Miniflux.

## Behavioural risks of ranking

- **Filter bubble.** Ranking by similarity to what you already read narrows what you see. The novelty boost, the serendipity flag from outside scoring and the Unread view in feed order are the counterweights. The Ranked toggle is optional, and the default view is grouped by feed.
- **Not a quality signal.** A high score means similar to your habits. It does not mean accurate, current or well sourced. For clinical or policy reading the user remains responsible for appraising the source.
- **Dismiss cost.** Dismissing lowers a feed's standing, which can hide a good feed after a few impatient clicks. Dismissals are reversible with Undo dismissed, and standing fades with a 14 day half life.
- **Explainability.** Every score has a plain sentence saying why, and the details row shows the four components. No hidden signals are used.

## Security review

- UI text is inserted as text nodes. Article HTML is rebuilt by an allowlist sanitiser (`src/safehtml.js`) that parses it into an inert document and copies only known tags and attributes into DOM nodes. Scripts, frames, forms, styles, SVG, event handlers, `javascript:` and `data:` links, and `srcset` are dropped. Links get `noopener`. There is a node limit. `innerHTML` is never used.
- The extension page's content security policy is Firefox's default for extensions, which blocks inline and remote script.
- Article links open in a background tab with a normal browser navigation. Card content is Miniflux's HTML after sanitising.
- Host permissions are limited to the three default services. Other servers need an explicit prompt. The `menus` permission was added in 0.3.0 for the right-click item; it cannot read pages. The address handed to the reader through the link is URL-decoded, must start with `http://` or `https://`, and is only put in a text box for the user to press Find feeds.
- The WebDAV client builds URLs from path segments with encoding, so a hostile file name cannot escape the folder.
- Corrupted or malicious lines in another machine's log are validated and skipped. They cannot execute and cannot overwrite local state, because merging only adds events with valid shape.
- A malicious other machine with write access to the same WebDAV folder could add events, for example mass dismissals. Treat the folder as trusted.

## Residual risks to accept knowingly

- Unencrypted keys in the Firefox profile.
- Two machines may show slightly different scores until their inputs match.
- Real-server behaviour is not yet verified (see README).
