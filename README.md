# Hark

A private, installable, offline-first audiobook player for the chaptered MP3s
that Epub Listener (a sibling project) produces. One account is one
solo library: import an MP3, keep its embedded chapters, and resume exactly
where you left off on any device.

**Your audio never leaves your devices.** The MP3 is parsed in the browser and
stored in this device's own storage; the server only ever sees metadata —
titles, chapters, progress, and playback history. There is no upload, no object storage,
and no practical file-size limit beyond the device's free space, so a single
600-hour audiobook imports the same way a two-hour one does. If the MP3 carries
an embedded read-along transcript, its text is book content too, so it is stored
on the device alongside the audio and never included in any server request.

**Your library reads from the device, too.** Every book row, chapter, tag and
position is mirrored into this device's IndexedDB, and the library screen reads
only from there; the network syncs afterwards, in the background. The design
contract for that is `docs/local-first.md`.

## What it does

- **Import**: parses the MP3 entirely in the browser — title/author/narrator,
  embedded cover art, and ID3/FFMETADATA chapters (a valid chapterless MP3
  plays as one chapter with an honest diagnostic; non-MP3s are rejected) —
  registers the metadata, and stores the audio bytes on this device only.
- **Play**: persistent player with chapters, scrubbing, configurable skip
  intervals, 0.5x–3x speed, sleep timer (presets, custom minutes, end of
  chapter), a 50-action playback history, finished/restart state, and
  lock-screen Media Session controls where the browser supports them.
- **Read along**: books whose MP3 carries an Epub Listener transcript get a
  "Text" toggle in the player and a "Read-along" badge in the library. Tapping
  it swaps the cover for the book text, where the narrated sentence highlights
  and auto-scrolls and the exact spoken word is marked karaoke-style; tap a
  sentence to jump there. It works fully offline. Books without a transcript
  look and behave exactly as before. (Transcript, if present, is validated and
  size-capped in the browser; a malformed one is dropped and the audio still
  imports.)
- **Resume anywhere**: positions, playback history, and library organization sync
  through the server with per-device monotonic sequences and deterministic
  conflict rules. Every write is journaled to a local outbox first, projected
  onto the local mirror second, and replayed against the server by its
  `mutationId` so a retry is a no-op rather than a double-apply. On a device
  that doesn't hold the audio yet, the player asks for the original MP3 and
  verifies it by size and content fingerprint before attaching it.
- **Offline**: the library screen reads this device's IndexedDB mirror, so
  search, filters, sort, the "On this device" facet and the continue card behave
  identically with the network off — there is no "am I online?" branch on the
  read path. The `/library` document itself is served from Cache Storage without
  touching the network, so a cold database and airplane mode cost what wifi
  costs: warm-launch p95 measures 291-370ms across fast, slow,
  3000ms-cold-database and offline profiles — a 70-73ms spread — with zero server
  document hits and zero Postgres queries. Those figures are taken under 4x CPU
  throttling with a fresh browser process per launch, so they mean something on
  a phone rather than on a desktop. Imported audio is served by the service
  worker with full seeking, and queued writes replay when the app is next open.
- **Organize**: search, status and tag filters, an "On this device" facet, sort
  orders, grid/list views, collections with optional next-book autoplay,
  archive, and delete. There is one library screen: books whose audio is not on
  this device stay browsable, searchable, taggable and sortable, are marked as
  not on the device, and never look playable.
- **Own your data**: JSON export of all metadata/progress and full account
  deletion (rows and this device's local data — the audio files were always
  yours).

## Local setup

1. Install Node.js >= 20.9 and pnpm 9.
2. `cp .env.example .env.local` and fill in the values (see below).
3. `pnpm install`
4. `pnpm db:migrate`
5. `pnpm dev` → http://localhost:3000 (or `pnpm build && pnpm start` for the
   production build, which is what enables the service worker).

### Environment variables

| Variable             | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`       | Postgres connection (Neon or any Postgres 15+). Never commit it. |
| `BETTER_AUTH_SECRET` | Session signing secret.                                          |
| `BETTER_AUTH_URL`    | The app's own origin, e.g. `http://localhost:3000`.              |

Optional: `RESEND_API_KEY` and `MAIL_FROM` enable password-reset email in
production (see `docs/operations.md`); in development, reset mails are written
to `.data/mail/` instead.

### Test database

Tests never touch the hosted database: its cold start makes runs slow and flaky,
suites must work offline, and parallel runs against one shared remote database
interfere. `docker-compose.yml` provides a local Postgres 18 matching the hosted
server's major version and locale (builtin `C.UTF-8`), with the `pg_trgm`
extension migration 0009 needs, published on `127.0.0.1:54329`.

```sh
cp .env.test.example .env.test   # local-only, gitignored
node scripts/test-db.mjs         # generates the secrets, then starts, migrates and seeds
```

Everything test-related reads `.env.test`, never `.env.local`. Override the file
with `HARK_ENV_FILE=<path>` or `--env-file=<path>`. `scripts/lib/assert-local-database.mjs`
aborts the e2e config, the standalone test server, and this bootstrap script if
`DATABASE_URL` ever points at a hosted provider such as Neon.

## Commands

| Command                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                        | The full non-browser gate: format check, lint, typecheck, all tests, production build.                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test`                          | Vitest suites (MP3 and transcript parsing contracts, service-worker range/navigation/shell logic, progress conflict policy, the outbox and the mirror, IndexedDB upgrades, playback).                                                                                                                                                                                                                                    |
| `pnpm test:idb-migrate`              | Just the IndexedDB upgrade suite: every shipped version of both databases is opened from a fixture and carried forward, so downloads, transcripts and a pending deletion journal survive `chapterline-offline-v1` v7 and outbox v4.                                                                                                                                                                                      |
| `pnpm test:e2e:ios`                  | Production iPhone/WebKit flow: register, choose from Downloads, play, seek, relaunch, and play offline.                                                                                                                                                                                                                                                                                                                  |
| `pnpm test:e2e:launch`               | The launch benchmark in `tests/perf/`: warm launch to real library content over four networks (fast, slow, 3000ms cold database, offline), asserting p95, spread, server document hits and Postgres queries.                                                                                                                                                                                                             |
| `pnpm test:e2e:parity`               | The parity project in `tests/parity/`, whose harness removes the network at the socket instead of through Playwright interception, because interception sits above the service worker and can be bypassed.                                                                                                                                                                                                               |
| `pnpm test:sync`                     | The data-integrity project in `tests/sync/`: outbox durability and coalescing, two-device convergence, progress conflicts, mirror/audio eviction recovery, lossless re-import, a seeded mutation fuzz across offline/online transitions, and one spec that makes its edits by clicking the real controls with the network off — the fuzz drives the engine directly, so only that one can prove the shipping UI uses it. |
| `node scripts/test-db.mjs`           | Starts the local Postgres container, migrates it, and seeds the e2e account. Subcommands `up`, `reset`, `down`, `migrate`, `seed`, `guard`, `psql` are also exposed as `pnpm db:test:*`.                                                                                                                                                                                                                                 |
| `pnpm db:migrate`                    | Applies ordered SQL migrations (idempotent; proven from an empty database).                                                                                                                                                                                                                                                                                                                                              |
| `node scripts/seed-perf.mjs <email>` | Seeds 1,000 books / ~60k rows onto an existing account for performance work.                                                                                                                                                                                                                                                                                                                                             |

Browser-level verification uses `agent-browser` against the production build,
exercising the core flows (register, import, play, offline, resume) across
phone, tablet, and desktop viewports.

Three limits are worth stating before reading a green run as more than it is.
The launch benchmark measures in a **Chromium** persistent context with iPhone 15
emulation: in Playwright 1.61.1, WebKit's persistent context accepts
`cache.put()` but returns nothing from `cache.match()`, in the page and in the
service worker alike, so the app's worker cannot even install there. The harness
probes WebKit first on every run and will switch back automatically when that is
fixed; until then, WebKit PWA coverage comes from `tests/e2e/iphone-pwa.spec.ts`.
The outbox drains only while the app is open, because iOS will not wake a closed
PWA — an offline write reaches the server on the next foregrounded launch or
reconnect, never before. And audio evicted by the OS is gone: it exists nowhere
but the device, so the book stays visible with its metadata and asks for the MP3
again.

## Repository layout

All application code lives in `src/` (~17k lines, plus ~7k of co-located unit
tests): `app/` (routes and API), `components/` (UI), `lib/` (the device mirror,
the outbox and sync, storage, playback history), `server/` (DB schema, queries,
and the sync pull), and `domain/` (pure logic). Migrations are in `drizzle/`,
browser-driven suites in `tests/` (`e2e/`, `perf/`, `parity/`, `sync/`), and the
service worker (maintained directly, not build-generated) is `public/sw.js`.

Everything else on disk is generated and git-ignored — `.next/` (the Next.js
build, ~500MB and hundreds of thousands of lines of compiled JS),
`node_modules/`, `tsconfig.tsbuildinfo`, `test-results/`, and `.vercel/`. A
line count that includes those directories will look ~50x larger than the
actual source; count `src/` (plus `drizzle/` and `tests/`) for a real figure.

## Documentation

- `docs/architecture.md` — stack, boundaries, data rules, the local read model,
  the write path, and the launch path.
- `docs/local-first.md` — the design contract for the device-authoritative
  library: what is mirrored, the outbox, pull, conflict rules, the launch path,
  eviction, and account lifecycle.
- `docs/operations.md` — deployment, backups, troubleshooting, limitations.
- `docs/ios-pwa-testing.md` — automated WebKit and physical-iPhone release gates.
