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
