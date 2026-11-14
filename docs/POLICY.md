# Policy and risk review

This is a design review of a personal tool, not legal advice.

## Data and privacy

- **No telemetry.** The manifest declares that the extension collects no data. Nothing is sent to the author or any analytics service.
- **Where data goes.** Only to servers the user configures: their Miniflux, their Fastmail WebDAV and Raindrop (api.raindrop.io). Article text stays in Miniflux and the local cache.
- **Browsing history.** History and bookmarks are read locally to build the echo profile. Only a term vector and domain counts leave the machine, and only to the user's own WebDAV folder. Page URLs and titles of visited pages are not uploaded.
- **Credentials.** The Miniflux key, WebDAV app password and Raindrop token are stored in the extension's local storage, which Firefox keeps unencrypted in the profile folder. Anyone with access to the profile can read them. Use a Fastmail app password limited to Files, and a Miniflux key you can revoke. Syncing keys through Firefox Sync is optional and off by default.
- **Outside scoring.** `enrich/outbox.json` holds titles, summaries and links of borderline articles and the top terms of the interest profile. If the user connects an outside assistant, those leave the user's storage. Turning this on is the user's decision, and the file contains no credentials.

## Third-party terms

- **Miniflux.** Uses the documented REST API with a personal API key. Polling is every two minutes by default against the user's own account, which is within normal use for a hosted account. Raise the interval if the host asks.
- **Raindrop.** Uses the official REST API with a personal test token. Reading is paged and cached for a day. Saving is one way. The claim that Raindrop generates tags with a local model is unconfirmed, so Pravaha does its own local tag matching instead.
- **Fastmail.** Uses WebDAV with an app password, as Fastmail documents for Files.
- **Mozilla.** Distributed as a self-signed (unlisted) add-on, which Mozilla's terms allow. It is not listed on addons.mozilla.org, so it does not go through listed-add-on review.
- **Publishers.** Pravaha shows Miniflux's own content and links out to the original page. It does not bypass paywalls and does not scrape. "Fetch full content" is a Miniflux feature and is not used here.

## Behavioural risks of ranking

- **Filter bubble.** Ranking by similarity to what you already read narrows what you see. The novelty boost, the serendipity flag from outside scoring and the Unread view in feed order are the counterweights. The Ranked toggle is optional, and the default view is grouped by feed.
- **Not a quality signal.** A high score means similar to your habits. It does not mean accurate, current or well sourced. For clinical or policy reading the user remains responsible for appraising the source.
- **Dismiss cost.** Dismissing lowers a feed's standing, which can hide a good feed after a few impatient clicks. Dismissals are reversible with Undo dismissed, and standing fades with a 14 day half life.
- **Explainability.** Every score has a plain sentence saying why, and the details row shows the four components. No hidden signals are used.

## Security review

- All user content is inserted with `textContent`, never `innerHTML`, so a hostile feed cannot inject script into the reader screen.
- The extension page's content security policy is Firefox's default for extensions, which blocks inline and remote script.
- Article links open in a background tab with a normal browser navigation. The reader does not render remote HTML.
- Host permissions are limited to the three default services. Other servers need an explicit prompt.
- The WebDAV client builds URLs from path segments with encoding, so a hostile file name cannot escape the folder.
- Corrupted or malicious lines in another machine's log are validated and skipped. They cannot execute and cannot overwrite local state, because merging only adds events with valid shape.
- A malicious other machine with write access to the same WebDAV folder could add events, for example mass dismissals. Treat the folder as trusted.

## Residual risks to accept knowingly

- Unencrypted keys in the Firefox profile.
- Two machines may show slightly different scores until their inputs match.
- Real-server behaviour is not yet verified (see README).
