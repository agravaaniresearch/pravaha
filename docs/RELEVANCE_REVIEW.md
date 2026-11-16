# Relevance engine: mathematical review (0.8.0)

An independent review of the 0.7.0 relevance engine, done before 0.8.0. Every number came from scripts run against the real code on synthetic data (4,400 bookmarks across 10 invented interests, 3,000 articles, 200 feeds) in Node 22. The direction of each finding is robust; the size on a real library is unproven, because the synthetic interests share no vocabulary. The Stats page ("Share opened, by relevance") is where the effect on your own reading shows.

## What was wrong in 0.7.0

| # | Severity | Defect | Measured |
|---|---|---|---|
| D1 | High | Feed standing was `clamp(0.3 + sum of signals)`. It measured volume, not rate, and saturated. | A feed of 100 articles a day with 2 opened and a feed of 1 a day with every one opened both scored 1.0. |
| D2 | High | Because of the clamp, a heavy month kept a feed pinned at the top long after you stopped reading it. | 200 opens in 30 days held standing at 1.0 for 62.7 idle days. |
| D3 | High | "Tag match" compared each article with one average of every bookmark, which sits between your interests. | For an interest holding 7% of bookmarks: on-topic 0.078 against off-topic 0.065. The best single tag gives 0.33 against 0.053. |
| D4 | High | The interest profile was a chain of blends, so each open shrank the bookmarks' share geometrically. | Bookmark share after 20, 50 and 100 opens: 0.36, 0.077, 0.006. |
| D5 | Medium | The profile was pruned before the pulls, so it grew without bound. | 1,045 terms after 100 opens. |
| D6 | Medium | One open counted three times: standing, a profile pull, and a browser-history visit in the echo signal. | |
| D7 | Medium | Undo was not exact. | Save 28 days ago and unsave now netted -0.19. |
| D8 | Medium | Every open, card, save or dismiss rebuilt the whole model. | 583 ms per card view. |
| D9 | Medium | `cosine` listed the keys of the 500-term profile on every call. | 90 ms for 3,000 articles, against 25 ms. |
| D10 | Medium | Designators vanished in tokenising and HTML entities became words. | "F-35 and S-400 deal with Su-57 MQ-9B" gave `deal, su, mq, 9b`; `rsquo` and `mdash` became words; "US" was dropped as "us". |
| D11 | Medium | A signal with no source kept its weight. | Without browsing history no article could score above 0.7. |
| D12 | Low | A future publish date counted as brand new; a missing date as 1970. | |
| D13 | Low | A missing weight turned every score into 0. | |
| D14 | Low | A damaged training value zeroed every matching article. | |
| D17 | Low | A remote clock far ahead was adopted, freezing decay for every machine. | |
| D19 | Low | The display stretch clipped at 0.65, so the top of the list looked alike. | |
| D21 | Note | The stemmer splits some word families (`supply` / `supplies`). | Not changed: stems are stored in keyword rules, so a fix needs a migration. |

Checked and sound: decay underflows cleanly, negative ages are clamped, `derive` sums in sorted order so machines agree bitwise, prune and topTerms break ties by key, freshness is monotone, training is capped.

## What 0.8.0 does instead

1. **Standing is an engagement rate** (D1, D2, D7). A decayed Beta-Bernoulli estimate: `rate = (10 x m + engaged) / (10 + trials)`, shown as `rate / (rate + m)`, where `m` is your average across feeds, so an average feed sits at 0.5 and a feed three times better at 0.75. Each article counts once, from its final state (card 0.25, open 0.5, long read 0.25, saved 1, capped at 1). The trials are how many articles the feed published, logged once a day as a `calibration` event (an event type every earlier version already accepts and ignores) and merged by the larger count per feed and day, so the result does not depend on which machine logged it. Measured: firehose 0.39, small fully read feed 0.96.
2. **Best-tag match** (D3). The article is compared with each of your Raindrop tags (tags with at least two saves, small ones shrunk by n/(n+1)) through an index built once, and the better of that and the whole-profile match is used. The reason line names the tag.
3. **A bounded profile** (D4, D5). The profile is your bookmarks plus what you opened, saved and thumbed up, which together can never take more than 30 percent of it and fade with a 60-day half life. After 300 opens it still resembles your bookmarks (cosine above 0.7; the old chain fell below 0.3).
4. **Hot stories** (Fever). Articles from different feeds within 36 hours that share at least two of their top terms and have a cosine of 0.35 or more are the same story. Heat is the number of other feeds carrying it, scaled as `ln(1 + k) / ln 6`. No chaining, so one generic article cannot heat a whole day. Rows show "3 feeds".
5. **Counted once** (D6). Pages opened from Pravaha are left out of the browsing-history echo, and the echo domain bonus is smooth (`min(0.15, 0.05 x log2(1 + visits / 3))`) instead of a step.
6. **Guards** (D9, D11 to D14, D17). A fast dot product, NaN-safe clamps, rule values clamped to -3..3 and damaged ones skipped, missing weights filled from the defaults, absent signals hand their weight to the others, future dates not trusted beyond when Miniflux first stored the entry, a remote clock more than a day ahead not adopted.
7. **Text** (D10). Entities are decoded, `F-35` becomes `f35`, `S-400` becomes `s400`, and "U.S." is kept as `usa`.
8. **Display** (D19). An odds stretch (`1.25s / (1.25s + 1 - s)`) that never clips.

Default weights: tag 0.40, echo 0.20, standing 0.20, freshness 0.10, hot 0.10. The weights, the engagement values, the prior of 10 and the hot threshold are judgment calls, editable or easy to tune once real data is seen.

### Effect on the synthetic library

| | AUC, all interests | AUC, minority interest | On-topic in the top 100 | Score p50 / p90 / p99 |
|---|---|---|---|---|
| 0.7.0, full score | 0.515 | 0.466 | 87 | 0.26 / 0.35 / 0.40 |
| 0.8.0, full score | 1.000 | 1.000 | 100 | 0.52 / 0.63 / 0.70 |

The 1.000 is an upper bound from interests that share no words. In 0.7.0 the general feeds were opened often in absolute terms, so their saturated standing swamped content; that is the effect to expect on a real library too, at a smaller size.

### Speed (Node 22)

| Task | Time |
|---|---|
| Score 3,000 articles (500-term profile, 300 tag profiles, standing, hot) | 48 to 56 ms |
| Hot clustering over 3,000 articles | 8 ms |
| Standing over 20,000 events | 23 ms |

## Rejected or deferred

- **Diversity re-ranking (MMR) or per-feed caps.** Rejected: the default view groups by feed and sorts by time, so the score only colours rows, and in the ranked view the firehose is now fixed at the source.
- **Learning the weights online (logistic regression).** Deferred: there are no per-article impressions to give negatives, opens are biased by the ranking itself, and a sigmoid would break "the bars add up to the score". A later step can fit weights offline from the history.
- **Percentile colouring.** Rejected: colours would change when other articles arrive.
- **Stemmer fix (D21).** Deferred until it can ship with a migration of stored rule keys.

## Determinism

`feedStanding` reduces each article with order-free operations (earliest first touch, flags, last writer by timestamp), merges exposure by the larger count, and sums over sorted keys, so it is a function of the set of events. The tests shuffle and duplicate events and compare. Nothing in the scoring reads a clock or a random number. Shared caveat: JavaScript does not require `pow`, `exp` and `log` to round identically across engines, so Firefox machines agree with each other while a Node run may differ in the last bit; scores are rounded to three decimals.
