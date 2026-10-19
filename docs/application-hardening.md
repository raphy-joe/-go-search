# Application Hardening (Review Items 1-8)

This change is local only. It does not deploy, change domains, configure TLS,
rotate credentials, enable 19Road, or change the 180-day strength window.

## Data Integrity and Freshness

- Event indexing uses the typed Yunbisai groups API, with the existing HTML
  parser only as a fallback. Live/index discovery share the same adapter.
- Participant publication validates each group before committing in one SQLite
  transaction. Missing participants, fewer played rounds, duplicate IDs, malformed
  records, and failed groups cannot replace a better stored group.
- Complete groups can still be published when another group fails. Missing old
  groups are retained. Group ownership conflicts roll back the whole transaction.
- Index metadata distinguishes `success`, `partial`, and `failed`; successful and
  attempted timestamps are separate. Every failure remains eligible for retry.
  The previous known-good match-cache guards remain in force.
- Coverage is not rounded up to 100%. Last successful update does not mean every
  event is fresh. Partial search results and stale match-cache fallback are marked.
- Conservative coverage guards can retain a participant who genuinely withdrew or
  was removed upstream. Such corrections require verification rather than silent
  destructive replacement.

## Prediction Safety and Resource Limits

- Missing historical rounds, omitted historical pairings, duplicate appearances,
  or official played totals beyond downloaded history return an explicit 422.
  An unpublished future round can still be simulated internally. Simulated
  pairings are not presented as official pairings.
- Historical gaps cannot be simulated on top of official cumulative scores.
  UI probabilities are cleared if history becomes insufficient on refresh.
- CPU simulation runs in worker threads: two active workers, six queued jobs,
  a 20-second deadline, 128 MB heap per worker, and at most 1,500 players.
- Upstream reads allow eight active requests and 64 queued requests, a 30-second
  queue/work deadline, and a 5 MB body limit. The slot covers reading the body.
- API requests allow 16 active globally and six per IP, with a 60-second deadline.
  Existing expensive-route rate limiting remains enabled. Round count is capped
  at 30 and simulations at 8,000; invalid dates and repeated query parameters fail.
- Browser replacement/clear/stop and client disconnects cancel foreground work.
  Administrator-started indexing/crawling is independent of the initiating request.
  Stopping the indexer waits for all its workers before accepting a new run.
- Completed prediction/snapshot caches are bounded. These are single-process
  protections, not distributed admission control or a production load-test result.

## Player Identity

- Search returns separate candidate trajectories, not one implicitly merged
  aggregate. Selecting a trajectory scopes strength, promotions, and head-to-head.
  Same-group different participant IDs are always separated.
- The main province is chosen primarily by non-national appearances. Travel alone
  is not conflicting evidence. Away records join the main trajectory only when
  every away tournament is a nationwide open and its contemporary strength is
  similar to the main region. Otherwise records stay separate pending selection.
- Nationwide eligibility requires an explicit national/international open title
  or affirmative language in a cached regulation. The word "open" alone is not
  sufficient; unavailable evidence is not guessed. This does not crawl new
  regulations during every search and is limited by cached source coverage.
- Strength comparisons reuse the existing group/performance baseline within
  180 days: a gap at most 1.25 L is similar, at least 2 L is conflicting, and the
  middle/unknown range is unresolved. These are configurable-in-code heuristics,
  not official rank or identity rules. They need calibration against real examples.
- Normal long-term growth in the main region is not split just because strength
  changed. Same-province namesakes without contradictory registration evidence
  are still a residual ambiguity; this is not legal identity verification.
- Result actions retain the searched name/province and participant anchors even
  if form fields are edited. Browser opponent caches no longer use names as keys.
- Promotion output remains the route list only; no confidence or inference text.

## Security and Operations

- CSP limits scripts/connections to this origin, denies framing/objects, and
  allows existing inline CSS only. Also sets nosniff, referrer and permissions
  headers, and disables the Express version header. No HTTP-to-HTTPS redirect.
  HSTS is emitted only for requests already known to be secure.
- The existing bearer-token admin guard and loopback-only proxy trust remain.
  Dependencies are updated; runtime requires Node.js 22 or later.
- Expected API errors have stable codes; unknown upstream/internal error details
  are not exposed in JSON or the search stream. Native autocomplete and new-tab
  navigation remain unchanged.
- HTTP still lacks transport encryption. Do not send administrative credentials
  over a public HTTP connection; use a protected SSH tunnel until HTTPS is set up.

## Yunbisai Compatibility

- JSON and JSONP responses share explicit business-error, identity, numeric and
  required-field checks. Missing real-player scores are not zeroes. A nonexistent
  bye/absence opponent may legitimately have a null score.
- Published group result lists and their structured tables supplement the legacy
  participant and pairing feeds. Tables must have complete columns, unique player
  identities, reciprocal opponents and consistent cumulative points. Unsupported
  or incomplete tables retain existing records instead of guessing outcomes.
- Verified reports are persisted in `published_group_results`. Older publications,
  shorter round coverage and missing participant identities cannot replace them.
  Explicit unscored games are accepted only with a publication after the verified
  event end; they never become draws or bye wins. A cached report can remain
  usable during a legacy-feed outage only after final-round snapshot validation,
  with a visible stale-source warning.
- Fully reconciled final results display official ranks, not a Monte Carlo
  estimate, and ignore hypothetical extra rounds. Ongoing forecasts retain their
  primary ranking assumptions. Prediction version is `rank-simulation-v5`;
  strength still uses the unchanged 180-day model.
- Event ingestion persists `max_time`, with an additive migration for existing
  databases. The live-event finder supplements current upstream pages with the
  local overlapping-date directory, then reads groups and pairings live. Existing
  directories gain end dates on their next regular crawl; no full recrawl is
  automatically triggered by deployment.
- Pagination follows actual page metadata rather than assuming `PageSize` is
  honored. The live scan has an eight-second budget and caps of 12 provincial or
  24 nationwide pages. Truncated scans/results disclose incomplete coverage;
  repeated pages and business errors are not successful empty searches.
- Formal-source verification failures mark indexing partial while retaining
  usable participant rows, so coverage does not silently claim full validation.
- Formal history retains nonparticipant placeholders when replacing a guarded
  legacy cache. Virtual bye/absence entries are not missing contested results.
  Match responses include all verified available rounds, even when the requesting
  result card still carries an older game count.
- The lockfile pins the patched `proxy-addr` 2.0.8 dependency. Proxy trust remains
  loopback-only; no authentication or network exposure settings were relaxed.

## Tie Boundaries and Refresh Policy

- Unknown event-specific head-to-head, opponent-score cuts, penalties and lots
  are not inferred from table column names. The association's published rules
  allow different methods, not a universal tournament comparator:
  https://wqwh.weiqi.org.cn/rules/
- Ongoing forecasts expose `rank_intervals` and `top_n` probability bounds under
  the selected primary ranking assumption. A tied block crossing the Nth slot
  contributes only to the upper bound. No random tiebreak or guaranteed shared
  rank is substituted for an actual qualifying place. The legacy `probabilities`
  field remains a distribution of the best shared rank for API compatibility;
  the UI uses intervals, not that field. Bounds cover unresolved tiebreaks, not
  uncertainty in the 50/50 strength or simplified Swiss pairing assumptions.
- Live round sheets use a bounded 16 MiB / 32-group memory cache. Metadata round
  one and the latest completed/current/future rounds refresh after 10 seconds;
  earlier verified completed rounds are rechecked after five minutes. Failed
  or incomplete refreshes cannot erase already resolved historical games.
- Invalid mixed-age snapshots invalidate the round cache. During a temporary
  outage, a validated ongoing snapshot at most two minutes old may be returned
  with a visible warning, retaining its original timestamps. Older/incomplete
  snapshots cannot serve as prediction fallback. Formal final-result fallback
  continues to require the separate persistent final verification.
- `freshness` distinguishes the local read time, oldest sheet verification and
  locally observed result changes. It does not claim an upstream publication
  timestamp where the source provides none. Formal reports show their actual
  publication time separately.
- Upstream HTTP retries honor seconds/date `Retry-After`, abort signals and
  jittered exponential backoff. Long cooldowns fail fast; 429 and repeated
  temporary failures open a per-origin circuit with one recovery probe. Normal
  4xx and validation failures are not blindly retried. Background work is capped
  at four of the eight upstream slots, and foreground requests precede queued
  background work. Ops status exposes active cooldowns.

## Compatibility Probes and Compensation

- `npm run ops:upstream -- --output=work/upstream-compatibility.json` checks two
  event pages and a small known completed/long-running sample. It checks response
  schemas, ownership, roster completeness, duplicate sheets and legacy/formal
  discrepancies without publishing anything into the application database.
  Critical failures exit 2; recognized source discrepancies are warnings in the
  report. The independent GitHub workflow runs weekly or by manual dispatch and
  retains the JSON artifact. These are canaries, not proof that all events work;
  sample IDs need occasional maintenance as source coverage changes.
- The additive `index_retry_queue` migration enrolls existing failed/partial
  events. Failures are classified as transient (5-minute initial delay), missing
  data (6 hours), unavailable/schema (24 hours), or other upstream issues (1
  hour), with bounded exponential backoff and jitter. Success clears the retry.
- At minute 15 of each hour, at most 30 due events are compensated, skipping a
  run when crawl/index work is already active. This refetches those events, not
  the entire directory, and retains complete groups if another group fails.
  Nightly indexing respects the retry schedule; explicit force operations can
  bypass it. `node indexer.js --retry-only=true --limit=30` runs a bounded manual
  pass. Ops status includes per-category pending/due counts.
- Scheduled application work remains disabled by `BACKGROUND_TASKS_DISABLED=1`.
  No full crawl, Git push, server deployment or external schedule activation is
  performed by local verification.

## Verification and Local Preview

Run `npm test`, `npm run test:browser`, and `npm audit`.
Browser tests use Edge on Windows (Chromium elsewhere), real static pages and
security headers, with deterministic API fixtures. They cover identity switching,
stale-response isolation, retry, cancel, empty/error distinction, and 1440/390/320
pixel layouts. Screenshots are written under ignored `work/ui-hardening/`.

For isolated previews, set `DATA_DIR` to a SQLite backup directory containing
`yunbisai.db`, `BACKGROUND_TASKS_DISABLED=1`, `SEARCH_AUTO_BACKFILL=0`, and `PORT`
to a free local port. Search/live requests may still read upstream on demand;
only scheduled/initial jobs are disabled. Preview data is not production coverage.
Back up the database before deployment: index metadata migrations are additive,
but data/cache updates are persistent. Restore a verified backup for a database
rollback; do not overwrite a live SQLite file while the service is running.
