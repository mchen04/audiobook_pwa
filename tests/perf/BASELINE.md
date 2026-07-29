# Launch benchmark — proven-red baseline

Status: historical verifier record, not current production behavior

Repository-reference audit: 2026-07-28

This is the recorded output of `pnpm test:e2e:launch` against the launch path as
it exists today: `/library` is server-rendered off Postgres, behind two
`requireSession()` round trips plus `listBooksPage` + `getLibraryOverview`. The
run below is **red**, and that is the point — a benchmark that passed against
this code would be measuring something other than the launch.

|                    |                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Date               | 2026-07-24                                                                                               |
| Repository state   | `main` at `fab5f8c` (launch path unmodified; only the readiness marker and the query counter were added) |
| Database host      | `127.0.0.1:54329` (local throwaway Postgres, `.env.test`)                                                |
| Library size       | 1000 books (seeded by `scripts/seed-perf.mjs`)                                                           |
| App server         | `node scripts/run-standalone.mjs` (production build), reused via `HARK_REUSE_SERVER=1`                   |
| Playwright         | 1.61.1                                                                                                   |
| Measurement engine | **chromium** persistent context with iPhone 15 emulation — see "Engine" below                            |
| Result             | FAILED — 17 assertion failures (12 distinct messages) across all four profiles                           |

## Profile table

```
================================================================================================================
HARK LAUNCH BENCHMARK — time from launch to REAL library content on screen
library size: 1000 books · database host: 127.0.0.1:54329 · launches per profile: 6 · start_url: /library?source=pwa
engine: chromium persistent context (iPhone 15 emulation) — NOT WebKit; see capability probe below
bars: p95 <= 500ms on every profile · spread(p95) <= 150ms · zero server document hits · zero Postgres queries
================================================================================================================
profile                        p50       p95       max  timeouts  doc hits  api hits   asset  queries
----------------------------------------------------------------------------------------------------------------
A fast (0ms)                  85ms      92ms      92ms         0         6         6      79       81
B slow (400ms)               493ms     509ms     509ms         0         6         6      24       60
C cold database (3000ms)    3090ms    3104ms    3104ms         0         6         6      30       60
D offline                  15004ms   15007ms   15007ms         6         0         0       6        0
----------------------------------------------------------------------------------------------------------------
spread of p95 across profiles: 14915ms (bar 150ms)
harness overhead (node wall clock minus in-page performance.now at marker): p50 65ms · p95 84ms over 18 launches

Per-launch detail (ms [in-page ms] · marker · doc/api/asset server hits · postgres queries):
  A: 85[21]/books/1-1-13/16q  86[19]/books/1-1-13/13q  84[18]/books/1-1-13/13q  86[22]/books/1-1-13/13q  85[22]/books/1-1-13/13q  92[27]/books/1-1-14/13q
  B: 487[424]/books/1-1-4/10q  502[430]/books/1-1-4/10q  499[432]/books/1-1-4/10q  485[424]/books/1-1-4/10q  509[425]/books/1-1-4/10q  493[428]/books/1-1-4/10q
  C: 3087[3023]/books/1-1-5/10q  3099[3031]/books/1-1-5/10q  3095[3027]/books/1-1-5/10q  3104[3037]/books/1-1-5/10q  3090[3027]/books/1-1-5/10q  3090[3025]/books/1-1-5/10q
  D: 15004![-]/none/0-0-1/0q  15003![-]/none/0-0-1/0q  15004![-]/none/0-0-1/0q  15004![-]/none/0-0-1/0q  15007![-]/none/0-0-1/0q  15005![-]/none/0-0-1/0q
  (! = the readiness marker never appeared within 15000ms;
     that launch is recorded AT the timeout, which is a LOWER BOUND on its real cost)

Profile-armed self-checks:
  profile A: control fetch paid 16ms in the browser and 2ms from node against a configured 0ms delay
  profile B: control fetch paid 402ms in the browser and 404ms from node against a configured 400ms delay
  profile C: control fetch paid 3004ms in the browser and 3002ms from node against a configured 3000ms delay
  profile D: control fetch to /api/perf/probe failed to connect (network is genuinely gone)

Persistent-context proof (re-checked before each profile):
  before profile A: controller=http://localhost:64428/sw.js registration=http://localhost:64428/sw.js caches=[chapterline-shell-v5] entries=20 idb=[chapterline-offline-v1@7, chapterline-sync-v1@3, hark-playback-history-v1@4] cookies=1 (session cookie "chapterline.session_token" present)
  before profile B: controller=http://localhost:64428/sw.js registration=http://localhost:64428/sw.js caches=[chapterline-shell-v5] entries=20 idb=[chapterline-offline-v1@7, chapterline-sync-v1@3, hark-playback-history-v1@4] cookies=1 (session cookie "chapterline.session_token" present)
  before profile C: controller=http://localhost:64428/sw.js registration=http://localhost:64428/sw.js caches=[chapterline-shell-v5] entries=20 idb=[chapterline-offline-v1@7, chapterline-sync-v1@3, hark-playback-history-v1@4] cookies=1 (session cookie "chapterline.session_token" present)
  before profile D: controller=http://localhost:64428/sw.js registration=http://localhost:64428/sw.js caches=[chapterline-shell-v5] entries=20 idb=[chapterline-offline-v1@7, chapterline-sync-v1@3, hark-playback-history-v1@4] cookies=1 (session cookie "chapterline.session_token" present)
================================================================================================================
```

## What failed, and by how much

```
Error: profile A fast (0ms): the document was fetched from the server 6 time(s) across 6 warm launches.
       A warm launch must be served from Cache Storage, or the network is still on the paint path.
       Paths: GET /library?source=pwa (x6)
Error: profile A fast (0ms): 81 Postgres queries ran during warm launches. The warm-launch critical
       paint path must issue none.
Error: profile B slow (400ms): the document was fetched from the server 6 time(s) across 6 warm launches.
Error: profile B slow (400ms): 60 Postgres queries ran during warm launches.
Error: profile B slow (400ms): p95 is 509ms against a frozen 500ms bar
Error: profile C cold database (3000ms): the document was fetched from the server 6 time(s) across 6 warm launches.
Error: profile C cold database (3000ms): 60 Postgres queries ran during warm launches.
Error: profile C cold database (3000ms): p95 is 3104ms against a frozen 500ms bar
Error: profile D offline: the real library never appeared within 15000ms on some launches  (6 of 6)
Error: profile D offline: a launch finished without the readiness marker naming real content  (x6)
Error: profile D offline: p95 is 15007ms against a frozen 500ms bar
Error: spread between the slowest and fastest profile p95 is 14915ms against a frozen 150ms bar.
       The network must not change what launch costs.
```

Summarised:

| Profile         | p95                                     | over the 500ms bar by                | document server hits | Postgres queries |
| --------------- | --------------------------------------- | ------------------------------------ | -------------------- | ---------------- |
| A fast          | 92ms                                    | passes on time alone                 | 6 / 6 launches       | 81               |
| B slow          | 509ms                                   | +9ms                                 | 6 / 6 launches       | 60               |
| C cold database | 3104ms                                  | +2604ms                              | 6 / 6 launches       | 60               |
| D offline       | >=15007ms (censored at the 15s timeout) | +14507ms, real library never painted | 0 (network gone)     | 0                |

Spread of p95 across profiles: **14915ms** against a frozen **150ms** bar.

### The reported number is conservative

The oracle is wall clock measured in Node around `page.goto` + wait-for-marker,
so it carries Playwright's own round trip: p50 65ms, p95 84ms across the 18
non-offline launches. The in-page `performance.now()` at the moment the marker
landed is printed in brackets beside every launch (profile A: 92ms reported vs
27ms in-page). The harness therefore **over**-reports, never under-reports — the
safe direction, since overhead can turn a passing launch into a failing one but
never the reverse.

## Why profile A is the most important row

Profile A's p95 is 92ms. On timing alone it passes the 500ms bar comfortably —
and it is still wrong. Every one of its six launches fetched `/library?source=pwa`
from the server and ran 13-16 Postgres queries to render it. It is fast only
because the database is a container on loopback. That is exactly the failure a
timing-only benchmark waves through, and it is why the hit counter and the query
counter are hard assertions rather than diagnostics.

Profile D is the mirror image: 0 document hits, 0 queries, and it still fails,
because the service worker fell back to the cached `/offline` page, which carries
no `data-launch-ready` marker and is not the user's library.

## What the instruments proved about themselves

- **The delays bit.** Under profile C, a control request that no cache and no
  service worker could answer took 3004ms in the browser and 3002ms from Node.
  Under B, 402ms / 404ms. Under D, the control request failed to connect. The
  four profiles are four different networks, not four labels.
- **The persistent context persisted.** The same service worker script URL was
  registered _and controlling_ before all four profiles, with 20 Cache Storage
  entries, three IndexedDB databases and the httpOnly `chapterline.session_token`
  cookie intact throughout. No launch below was secretly a cold launch.
- **The readiness marker never fired early.** Every non-offline launch reported
  `books` (real book cards). Profile D reported `none` on all six launches rather
  than resolving against the cached offline page.

## Engine

The measurement runs in a **Chromium** persistent context with iPhone 15
emulation, not WebKit. This is not a preference; it was forced by a measured
Playwright limitation, and the harness re-probes it on every run
(`selectEngine()` tries WebKit first and only falls through on failure):

```
[launch-benchmark] engine probe · webkit persistent context: Cache Storage read-back = null — UNUSABLE for a cache-first launch measurement
[launch-benchmark] engine probe · chromium persistent context: Cache Storage read-back = "probe-body" — USABLE
```

In `webkit.launchPersistentContext` (Playwright 1.61.1, macOS 15), `cache.put()`
resolves and `caches.keys()` lists the cache, but **every `cache.match()` returns
`undefined`** — from the page _and_ from inside the service worker. Verified
against three configurations:

| context                            | SW activates | SW intercepts fetch | `cache.match()` reads back |
| ---------------------------------- | ------------ | ------------------- | -------------------------- |
| webkit `launchPersistentContext`   | yes          | yes                 | **never**                  |
| webkit `newContext`                | yes          | yes                 | yes                        |
| chromium `launchPersistentContext` | yes          | yes                 | yes                        |

The app's own service worker cannot even install there: `precacheShell()` throws
`"The required offline page was not cached."` because its `cache.match()` misses,
and the worker goes `redundant`. A harness pinned to WebKit persistent would be
permanently red for an infrastructure reason and could never turn green no matter
how correct the app became — which is a broken oracle, not a strict one.

**Residual risk, stated plainly:** iOS/WebKit fidelity of the _launch_ path is
not covered by this benchmark. WebKit coverage of the app's service worker,
offline media and PWA behaviour still comes from `tests/e2e/iphone-pwa.spec.ts`,
which uses a non-persistent WebKit context. When Playwright fixes WebKit
persistent Cache Storage, `selectEngine()` will pick WebKit automatically on the
next run and the header line will say so.

## After — the local-first launch path, under a stricter harness

Recorded 2026-07-25 against the same bars, the same 1000-book library and the
same local database.

**The harness did change between the two runs, and it changed in one direction
only: harder.** Saying otherwise would make the comparison below dishonest, so
the three changes are named here, and every frozen threshold — `P95_BAR_MS=500`,
`SPREAD_BAR_MS=150`, `LAUNCHES_PER_PROFILE=6`, `MIN_BOOKS=1000`, and the four
profile delays — is byte-identical to the baseline.

1. **A launch restarts the browser process** against the same `userDataDir`, so
   the profile stays warm while the process does not. The baseline reused one
   context for all 24 launches, which excluded every cold-start cost — and hid a
   real bug (below).
2. **The CPU is throttled 4x**, and the throttle is proved rather than assumed:
   a fixed 8M-iteration loop is timed at 1x and at 4x every run, and the
   measured slowdown is printed. `devices["iPhone 15"]` sets viewport and
   user-agent, never CPU, so the baseline's numbers were desktop numbers for a
   path that is almost entirely device-local work.
3. **The content assertion is real.** The baseline asserted only that _some_
   `data-launch-ready` marker appeared. The marker must now say `books`, the
   rendered cards are counted in the same tick, and the document must arrive as
   `deliveryType: cache-storage` with an empty transfer.

Two consecutive runs, each from a destroyed-and-rebuilt database and a fresh
build. Both are shown, because a single green run of a performance gate says
less than two that agree.

```
CLEAN PASS 1
profile                        p50       p95       max  timeouts  doc hits  api hits   asset  queries    marker    cards
A fast (0ms)                 289ms     291ms     291ms         0         0         0       0        0     books       50
B slow (400ms)               285ms     292ms     292ms         0         0         0       0        0     books       50
C cold database (3000ms)     336ms     361ms     361ms         0         0         0       0        0     books       50
D offline                    335ms     343ms     343ms         0         0         0       0        0     books       50
spread of p95 across profiles: 70ms (bar 150ms)
CPU throttle: a fixed 8M-iteration loop ran in 4ms at 1x, 16ms at 4x (4.00x observed)

CLEAN PASS 2
profile                        p50       p95       max  timeouts  doc hits  api hits   asset  queries    marker    cards
A fast (0ms)                 291ms     298ms     298ms         0         0         0       0        0     books       50
B slow (400ms)               286ms     297ms     297ms         0         0         0       0        0     books       50
C cold database (3000ms)     339ms     370ms     370ms         0         0         0       0        0     books       50
D offline                    341ms     346ms     346ms         0         0         0       0        0     books       50
spread of p95 across profiles: 73ms (bar 150ms)
CPU throttle: a fixed 8M-iteration loop ran in 5ms at 17ms at 4x (3.67x observed)
```

| Profile         | p95 before  | p95 after (pass 1 / pass 2) | doc hits | Postgres queries |
| --------------- | ----------- | --------------------------- | -------- | ---------------- |
| A fast          | 92ms        | 291ms / 298ms               | 6 → 0    | 81 → 0           |
| B slow          | 509ms       | 292ms / 297ms               | 6 → 0    | 60 → 0           |
| C cold database | 3104ms      | 361ms / 370ms               | 6 → 0    | 60 → 0           |
| D offline       | ≥15007ms    | 343ms / 346ms               | 0 → 0    | 0 → 0            |
| **spread**      | **14915ms** | **70ms / 73ms**             |          |                  |

Profile A is _slower_ than its baseline (92ms → ~298ms), and every part of that
is the honest direction. At baseline it painted the empty state, because the
mirror had not been populated; it now paints 1000 real book cards. Roughly 2.4x
of the remainder is the CPU throttle — the in-page figure printed beside each
launch went from ~85ms to ~205ms — and the reported number also carries ~109ms
of Playwright round trip that the in-page figure excludes. The harness therefore
**over**-reports, which is the safe direction: overhead can turn a passing
launch into a failing one, never the reverse.

### What restarting the process found

The old single-context harness kept one service worker resident for all 24
launches. Restarting it exposed that **Chromium speculatively fetches the launch
document whenever it has to boot the worker for a navigation**
(`ServiceWorkerAutoPreload`). The paint never waited for it — delivery was still
`cache-storage` with 0 bytes — but the server rendered `/library` and ran four
Postgres queries on every cold launch and the answer was discarded: 6 wasted
renders and 24 queries per run. `public/sw.js` now declares a static route for
the start_url so the browser answers from the cache without starting the worker
at all, which is why the table above reads 0 across both columns.

### The check is still able to fail

Three demonstrations, each run rather than argued:

- **Empty mirror.** Wiping the mirror's `books` and `bookTags` while keeping
  `syncMeta` — an eviction, not a first run — produced p95 234ms, zero document
  hits and zero queries: the best numbers this app has ever recorded, while
  showing "Bring your first audiobook" to an account owning 1000 books. The
  baseline harness calls that a pass. This one produces 48 failures.
- **A broken static route.** Declaring the route for a bare `/library` while the
  launch asks for `/library?source=pwa` misses, and a routing miss goes to the
  network rather than to the worker's own handler: 5371-5521 bytes on the wire
  per launch, p95 732ms on B and 3426ms on C. Caught on the first run after the
  change.
- **No cache-first branch.** Disabling it returns 6 document hits per profile,
  24 Postgres queries, p95 551ms/3152ms on B/C and a 3009ms spread.

## Reproducing

```
node scripts/test-db.mjs          # local Postgres on 127.0.0.1:54329, seeded
pnpm test:e2e:launch              # builds and starts the app, then measures
```

The harness seeds the benchmark library itself if the account holds fewer than
1000 books, and refuses to run against a hosted database.
