# Hark

A private, installable, offline-first audiobook player for the chaptered MP3s
that [Epub Listener](../Epub_Listener/README.md) produces. One account is one
solo library: import an MP3, keep its embedded chapters, and resume exactly
where you left off on any device.

**Your audio never leaves your devices.** The MP3 is parsed in the browser and
stored in this device's own storage; the server only ever sees metadata —
titles, chapters, progress, bookmarks. There is no upload, no object storage,
and no practical file-size limit beyond the device's free space, so a single
600-hour audiobook imports the same way a two-hour one does.

## What it does

- **Import**: parses the MP3 entirely in the browser — title/author/narrator,
  embedded cover art, and ID3/FFMETADATA chapters (a valid chapterless MP3
  plays as one chapter with an honest diagnostic; non-MP3s are rejected) —
  registers the metadata, and stores the audio bytes on this device only.
- **Play**: persistent player with chapters, scrubbing, configurable skip
  intervals, 0.5x–3x speed, sleep timer (presets, custom minutes, end of
  chapter), one-tap bookmarks with notes, finished/restart state, and
  lock-screen Media Session controls where the browser supports them.
- **Resume anywhere**: positions, bookmarks, and library organization sync
  through the server with per-device monotonic sequences and deterministic
  conflict rules. On a device that doesn't hold the audio yet, the player asks
  for the original MP3 and verifies it by size and content fingerprint before
  attaching it.
- **Offline**: every imported book is already local, served by the service
  worker with full seeking; offline progress/bookmarks replay idempotently on
  reconnect.
- **Organize**: search, status and tag filters, sort orders, grid/list views,
  collections with optional next-book autoplay, archive, and delete.
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

## Commands

| Command                              | What it does                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                        | The full non-browser gate: format check, lint, typecheck, all tests, production build.                                   |
| `pnpm test`                          | Vitest suites (MP3 parsing contract, range + service-worker parity, progress conflict policy, offline queues, playback). |
| `pnpm test:e2e:ios`                  | Production iPhone/WebKit flow: register, choose from Downloads, play, seek, relaunch, and play offline.                  |
| `pnpm db:migrate`                    | Applies ordered SQL migrations (idempotent; proven from an empty database).                                              |
| `node scripts/seed-perf.mjs <email>` | Seeds 1,000 books / ~100k rows onto an existing account for performance work.                                            |

Browser-level verification uses `agent-browser` against the production build,
exercising the core flows (register, import, play, offline, resume) across
phone, tablet, and desktop viewports.

## Documentation

- `docs/architecture.md` — stack, boundaries, data rules, offline model.
- `docs/operations.md` — deployment, backups, troubleshooting, limitations.
- `docs/ios-pwa-testing.md` — automated WebKit and physical-iPhone release gates.
