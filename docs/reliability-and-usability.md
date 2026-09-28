# Review Items 9-12

Local implementation, following items 1-8 in `application-hardening.md`.
Item 13 is excluded. No feedback workflow, favorites, exports, 19Road ingestion,
domain/TLS changes, Git push or production deployment is included.

## 9. Model and Rule Traceability

- `model-versions.js` is the version registry. Increment the relevant version
  when changing a model's behavior. Strength remains server-side only, with the
  same 180-day window and formula; a failed request offers retry rather than a
  different browser-side estimate.
- Predictions report model version, deterministic seed, input fingerprint and
  assumptions. The same inputs, rule, seed and simulation count reproduce the
  distribution. A shared live URL carries the scenario and seed but still fetches
  current upstream data: it is not an immutable historical snapshot.
- The inspected Yunbisai Againstplan response supplies `total_bout`, not verified
  ranking rules. The existing total-score formula is explicitly an **unverified
  default**. Users may select a score/opponent-score assumption; this is not an
  official rule discovery mechanism. Win/draw/loss points are 2/1/0, bye opponent
  score is zero, tied scores share ranks, and unfixed games remain 50/50. Details
  such as direct encounters, penalties, progressive scores, color and floating
  constraints are not modeled. Unpublished pairings use the existing simplified
  Swiss logic internally, never displayed as official pairings.
- `rules/promotion-catalog.json` records sources, scope, dates and manual-entry
  attribution. API provenance includes catalog/model versions and notice hashes;
  the final promotion UI still shows only the path, not confidence or reasoning.
- Hebei's 2017 text states an effective date of 2017-10-01, at least 20 entrants,
  at least seven rounds, and nine rounds for more than 32 entrants. These guards
  are now applied. Source: https://sport.hebei.gov.cn/m/view.php?aid=8392 . This
  verifies that historical text, not its continued applicability to every 2026
  event. An event-specific regulation takes precedence.
- Sichuan's legacy source `http://www.scwqxh.com/go-a327.htm` was not retrievable
  during this check. Its existing rules were not invented or broadened; the
  catalog explicitly records unavailable verification and unknown effective dates.
  User-confirmed entries are attributed to the project owner's confirmation, not
  falsely described as a retrieved association certificate list.
- Future catalog changes must include source evidence, applicability dates (or
  explicit unknowns), review date, reason and regression tests. Git history is
  the change audit; there is no new unauthenticated rule-editing endpoint.

### Historical Evaluation

```text
npm run backtest -- work/preview-hardening-20260928/yunbisai.db work/backtest-report.json
```

The read-only harness samples complete cached groups, requires official final
standings to agree with every recorded game, removes final-round outcomes and
all final scores/ranks from model input, and retains known final pairings. It
reports top-one/top-five hits, multiclass Brier score and final-rule agreement.
Players are sampled across the final ranking, only for evaluation selection.
No exclusions are written to the source database. Output must be a new file.

The local 2026-09-28 trial found only two eligible groups / ten sampled players;
three cached groups were skipped. Top-one hit rate was 40%, top-five 100%, Brier
score 0.6795744 and final-rule agreement 100%. This is a small convenience sample,
**not evidence of production accuracy or calibration**. There is no independent
ground-truth dataset for strength calibration; the strength formula was not
retuned to these results. Reports include detailed exclusions and versions.

## 10. Release, Monitoring and Recovery

CI runs Node 22/24 tests, production dependency audit, isolated smoke tests and
Chromium browser tests on pushes/PRs. Browser failures retain screenshots. The
workflow has been authored; GitHub execution requires a future push.

```text
npm test
npm run test:browser
npm run test:smoke -- --local
npm audit --omit=dev --audit-level=high
```

The local smoke command starts/stops its own isolated server and removes only its
own fresh temporary directory. To check an already running deployment, pass its
origin instead of `--local`. It verifies readiness, all three pages, CSP, input
validation and anonymous admin denial; it does not crawl upstream or mutate data.

`GET /healthz` checks database access. `GET /api/ops/status` requires the existing
`ADMIN_TOKEN`. It reports index failures/partial coverage, last successful update,
cached round gaps and their rate, and per-route request counts/error rates/P95.
Error rates and latency use at most the last 500 requests per route; counters
reset when the process restarts. The round-gap metric checks whole missing rounds,
not every board's completeness. Cache publication guards provide finer validation.
Slow requests and server errors emit structured log records without query strings,
names or tokens. Review log retention and access controls before production use.

```text
# Set ADMIN_TOKEN through the environment, never a URL or committed file.
npm run ops:check -- http://127.0.0.1:3031
```

The read-only check exits 0 for healthy, 1 for warnings, 2 for critical/unreachable.
Default thresholds: any failed/partial index warning, any missing-round group
critical, no successful index for 48h warning, error rate >5% critical or P95 >10s
warning after at least ten requests. Public HTTP credential transmission is
refused; until HTTPS exists, run on the server's loopback interface or an SSH
tunnel. An external scheduler/monitor must run the check and deliver alerts.
No alert delivery channel or production schedule was silently enabled.

### Backup and Restore Drill

```text
npm run backup -- backup data/yunbisai.db work/backup-NEW
npm run backup -- verify work/backup-NEW
npm run backup -- restore work/backup-NEW work/restore-NEW
```

Backup uses SQLite `VACUUM INTO` against a read-only source, providing a consistent
snapshot even with WAL enabled. It records SHA-256, schema hash and key table row
counts; `integrity_check` and all recorded checks are repeated on verification
and restore. Destination directories must not exist. Restore never replaces a
live database. A missing manifest means a backup failed and must not be used.

A real local drill on 2026-09-28 restored 22,187 events, 3,097 groups, 85,095
participants, 1,110 match rows, 19 notices and 182 manual pairing rows with matching
schema and checksums. This is the local preview database, not production data.

Production runbook: finish tests; record release SHA and runtime; take and verify
a backup; retain the prior release; deploy during a quiet window; run smoke and
authenticated ops checks; manually inspect one search/H2H/live group. On failure,
stop the service before switching releases or database paths. Restore a backup
into a new directory and validate there before repointing `DATA_DIR`; never copy
over an open SQLite database. Off-host encrypted copies, retention, secrets/config
backups and scheduled restore drills still need production configuration.

## 11-12. Query and Mobile UX

- Player results filter by year, event keyword and group without another crawl.
  These filters affect the visible list only; selected-identity strength still
  uses 180 days and promotion history still uses the full selected trajectory.
- Live ranking supports name/unit lookup, keyboard focus, and visible counts.
  New player tabs preserve selected ranking assumptions and total rounds.
- Search/H2H/live URLs retain query choices and prediction scenarios. Copy-link
  controls offer an address-bar fallback when the Clipboard API is unavailable.
  Shared URLs contain names and participant anchors: share them deliberately.
- Returning to a query restores conditions and scroll position. Starting a new
  query clears stale state. Native browser name autocomplete is unchanged.
- Mobile ranking retains name, rank and main score, with expandable secondary
  scores. Sticky headers/name cells support longer tables. H2H unit details are
  available in expandable rows instead of an excessively wide mobile table.
- Local Lucide icons, numeric formatting, focus states and expanded-state labels
  supplement the existing design; no redesign or external icon CDN is required.
- Browser tests use real HTML/CSS/security headers with mocked upstream data at
  1440, 390 and 320 pixels. They are not production network availability tests.
