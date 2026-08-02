# Architecture

## Status

Decision record started 2026-07-09; last reconciled with the code on 2026-07-28
after the resume-durability pass and repository-anatomy audit.
Update this document whenever executable reality changes.

`docs/local-first.md` is the design contract for that pass — what is mirrored,
the outbox, pull, conflict rules, the launch path, eviction, and account
lifecycle. This document records how the app is built; that one records why the
local-first rules are what they are, and it is not restated here.

`docs/repository-anatomy.md` classifies the large tracked paths. In particular,
Drizzle snapshots are required generated migration state, while the service
worker and resume oracle are authored behavior.

## Product boundary

The app accepts one MP3 as one audiobook. Every account is a solo private workspace; accounts provide authentication, ownership, isolation, and cross-device progress, not social identity. The app has no friends, follows, shared libraries, messages, invitations, feeds, or collaborative features. It does not accept EPUB/PDF, run TTS, expose a public catalog, or process DRM. Epub Listener is a read-only upstream producer whose FFmpeg/ID3 output is a compatibility contract.

## Stack

- Next.js 16 App Router, React 19, strict TypeScript
- Native CSS with semantic light/dark tokens
- Phosphor icons
- PostgreSQL on Neon
- Drizzle ORM and ordered SQL migrations
- Better Auth with database-backed sessions and rate limits
- `music-metadata` parsing MP3s and ID3 chapters in the browser at import
- Cache Storage for the device-local audio, covers, and the launch shell
- IndexedDB for the device-authoritative library mirror and the mutation outbox
- A native, versioned service worker for the launch shell, range serving, and
  the update lifecycle
- Vitest for unit/integration logic, Playwright for the WebKit PWA flow and the
  launch/parity/sync projects, and `agent-browser` for end-to-end UI verification
- A docker-compose Postgres 18 on `127.0.0.1:54329` for every test suite, with a
  guard (`scripts/lib/assert-local-database.mjs`) that refuses a hosted
  `DATABASE_URL`

## Why this stack

Next.js has current first-party App Router and PWA guidance and can keep private data and media authorization on the same origin. Drizzle supports Neon without hiding SQL or migrations. Better Auth supplies scrypt password hashing and cookie/session primitives that would be risky to recreate. A custom service worker is deliberately small because offline audio storage and conflict reconciliation need application-specific behavior rather than generic runtime caching.

## Runtime boundaries

```text
Browser UI (reads only from this device)
  -> playback engine (one HTMLAudioElement)
  -> IndexedDB library mirror + downloads + transcripts   (the read path)
  -> IndexedDB outbox                                     (the write path)
  -> same-origin JSON APIs, after paint only

Next.js server (metadata only — never audio bytes)
  -> auth/session boundary
  -> application services
  -> Drizzle/Postgres repository

Neon Postgres
  -> users/sessions
  -> books/media metadata/chapters (+ book tombstones)
  -> progress revisions/listening sessions
  -> playback actions, collections, tags
  -> rate-limit state
```

Postgres is the sync peer and the durable backup of metadata, not the read
model. Nothing the library screen renders comes from a server response on the
critical path.

## Data rules

- Every private row is owned directly or transitively by one user.
- Queries scope by authenticated user and resource ID at the same boundary.
- Audio bytes and cover blobs never leave the user's devices; Postgres holds
  metadata only, including a versioned content fingerprint for duplicate
  detection and cross-device file verification. New imports use whole-file
  SHA-256; legacy sample fingerprints remain readable for existing books.
- An embedded read-along transcript (a GEOB frame Epub Listener writes; format
  in that repo's `docs/transcript-format.md`) is book content, so it is treated
  like the audio: extracted, validated, and size-capped in the browser, stored
  per chapter in IndexedDB on the device, and never placed in any server
  request. A missing, malformed, or oversized transcript is dropped and the
  audio import is unaffected.
- Book deletion removes rows server-side and the local bytes client-side
  (including its transcript cues), and writes a `book_tombstones` row so other
  devices learn about the deletion from a positive record rather than from
  absence; account deletion cascades every row and wipes this device's local
  data.
- Progress uses device/session IDs and monotonic per-device sequence numbers. The server rejects duplicate/stale events while allowing an explicit user rewind.
- Auth rows (`user`, `session`, `account`, `verification`, `rate_limit`) and the
  `playback_action_receipts` idempotency ledger are server-authoritative and are
  never mirrored: a device may not mint its own session, and only the server
  writes its own receipt ledger.

## Media flow

1. Import happens in the browser: `music-metadata` parses the chosen file
   (shared pure interpreter in `src/domain/mp3.ts` — format validation,
   chapter normalization, artwork sniffing — when the format-level chapter
   list is truncated, the complete native ID3 chapter sequence is recovered
   instead, and sequences that don't cover the audiobook's duration are
   rejected as malformed), and a streaming whole-file
   SHA-256 identifies the exact bytes without buffering the book in memory.
2. `POST /api/books/local` registers metadata only — validated title/author,
   duration, byte size, fingerprint, and the full chapter list (revalidated
   server-side, batch-inserted, capped at 10,000 chapters). A database-unique
   owner/fingerprint pair makes concurrent duplicate imports atomic; a match
   answers 409 with the existing book id for device reattachment. On that
   duplicate path, if the newly parsed chapter list is a complete sequence and
   the stored one was truncated by an earlier import, the server repairs the
   existing book's chapters in the same transaction.
3. The audio bytes go into this device's Cache Storage under an
   `/offline-media/<uuid>` URL backed by independently cached 4 MiB chunks, with
   a per-user IndexedDB record; embedded cover art is stored beside it along
   with a downscaled thumbnail so small surfaces (library cards, downloads
   list, mini player) never decode full-size art. Fingerprint hashing runs in
   a web worker to keep `hash-wasm` out of page bundles. If
   storing fails, the metadata remains recoverable and choosing the MP3 again
   completes the device attachment.
4. Playback always serves from the device store through the service worker,
   which answers HTTP Range requests (the service worker's 206/416 parser is
   unit-tested directly). There is no server media route or server-side range
   parser.
5. On a device that lacks the bytes, the player's media gate asks for the
   original MP3 and verifies byte size and fingerprint before attaching it —
   positions and playback history were already synced through Postgres.

## Local read model

`chapterline-offline-v1` (version 7) is the read path. Alongside the existing
`downloads`, `transcripts`, `deletions` and `cacheEntries` stores it holds the
mirror: `books`, `chapters`, `playbackStates`, `tags`, `bookTags`,
`collections`, `collectionBooks`, `preferences`, `listeningSessions` and
`syncMeta`. Every store is keyed by `userId` first and carries a `by-user`
index, which is what makes an account purge a bounded, provable sweep rather
than a best-effort one. The v7 upgrade is additive: it creates stores and
rewrites nothing, so a device already holding downloads, transcripts and a
pending deletion journal comes through intact.

- `src/lib/offline/mirror.ts` owns it. A pulled batch lands as one transaction
  across every affected store, and the new cursor is part of the same commit,
  so the cursor can never be observed ahead of the data it describes.
- `use-library-books.ts` reads the mirror for metadata and `downloads` for the
  audio this device actually holds, and joins them. There is no "am I online?"
  branch on that path: search, status/tag filters, the "On this device" facet,
  sort and the continue card are all local computations.
- Cache Storage still holds the imported MP3 bytes and covers; localStorage
  still holds the active-user marker, user-scoped last positions, the device id
  and the preferences cache. The playback-history ledger lives in its own
  IndexedDB database (`hark-playback-history-v1`). Reads reconcile IndexedDB
  against Cache Storage so an OS-evicted media entry becomes an honest reattach
  flow instead of a broken player.
- Account deletion clears that user's local books, mirror, queues, positions,
  and preferences on the device; sign-out purges the account that is leaving,
  and sign-in purges every account _other_ than the one signing in — never the
  incoming account's own downloads, which exist nowhere else.

## Write path

Writes go through the outbox (`src/lib/offline-sync/`, database
`chapterline-sync-v1` version 5, plus `src/lib/offline/outbox.ts`):

- **Journal intent, then act.** The outbox row is committed first and the
  optimistic mirror patch second, so a crash can leave a queued write with no
  local projection (recoverable) but never a visible change with no queued write
  (a silent lost write). The two databases are deliberately separate and
  IndexedDB has no cross-database transaction, so ordering carries the guarantee
  — the same shape `deletion-journal.ts` already uses.
- **Idempotent replay.** `mutationId` is generated once at queue time and reused
  on every retry; replay hits the same REST routes the UI does, and the server
  dedupes. Kinds are `progress`, `import`, `metadata`, `tag`, `collection`,
  `archive`, `delete`, `history`. `MUTATION_COALESCING` states the policy per
  kind: progress collapses to the highest device sequence, renames/archive/tag
  and collection edges replace, and `import`/`delete`/`history` never coalesce.
- **Retry on launch and reconnect, never in the background.** iOS will not wake
  a closed PWA, so the queue drains only while the app is open, and no UI
  implies otherwise.
- `src/server/api/mutation-schemas.ts` holds every mutation route's accepted
  body in one place, and every schema is `.strict()`. That module exists because
  a replay body zod silently stripped produced a 200, an outbox row deleted as
  settled, and a reverted edit on the next pull;
  `mutation-replay-contract.test.ts` now runs every `toReplayRequest` body
  through the real route schema.

Pull is `GET /api/sync/pull?since=<iso>` (`src/server/sync/pull.ts`), which
returns changed book and collection aggregates plus the full tag vocabulary,
collection list, preferences and recent listening sessions under one read-only
transaction. Deletions arrive as `book_tombstones` rows, because absence cannot
be told apart from "not on this page". A pull runs after paint on launch and on
reconnect.

## Launch path

`public/sw.js` (shell cache `chapterline-shell-v6`) answers a `/library`
navigation from the cached user-agnostic shell **without calling `fetch` at
all**. That shell is the `/offline` document, which renders the same `AppShell`
and the same `LibraryClient` as `/library` and contains no book rows and no user
identity — which is what makes one cached copy safe across accounts, and why the
account purge keeps it (with `/icons/` and `/_next/static/`) while deleting
every other page-cache entry. `/library` itself still
checks the session server-side, but only to redirect a signed-out visitor; it
renders no user rows.

- Every other navigation goes to the network first, bounded by a 3000ms budget.
  The old `fetch(request).catch(...)` was not a fallback: `.catch()` fires only
  when fetch _rejects_, and a weak-but-alive mobile connection stalls instead,
  which showed a blank screen. When the budget is spent, anything the device can
  render for itself (`/`, `/library`, `/offline`, `/books/:id`) gets the shell,
  and an auth page gets a self-contained notice rather than being bounced back
  to `/login` forever.
- Install precaches the shell plus the `/_next/static` chunks parsed out of it,
  because a shell whose chunks are missing is a blank screen with extra steps.
  A deployment renames those chunks without changing `sw.js`, so the page posts
  `REFRESH_SHELL` once it has gone idle after launch.
- Revalidation (`src/lib/launch-revalidation.ts`) waits for the render that sets
  `data-launch-ready`, then for 500ms of quiet and an idle callback, before it
  touches the network. A device that has never completed a pull is the one
  exception: it has no painted library to protect, so it fills the mirror at
  once and shows a first-sync notice that deliberately carries no readiness
  marker.
- `/offline` still resolves as a URL because the service worker precaches
  exactly one navigation fallback and `cache.add` cannot store a redirect.
  Reaching it rewrites the address bar to `/library` with the history API; the
  library is already on screen either way.

Measured by `pnpm test:e2e:launch` on a 1,000-book library: warm-launch p95 is
134ms / 139ms / 146ms / 151ms across fast, slow, 3000ms-cold-database and
offline, a 17ms spread, with zero server document hits and zero Postgres queries
on every launch. The recorded pre-change baseline in `tests/perf/BASELINE.md` is
92 / 509 / 3104 / >=15007ms with a 14915ms spread. Hit counts and a query
counter, not timings, are what decide whether the document came from cache.

## One library UI

`/library` is the only library screen. The separate Downloads screen and its
stylesheet are deleted; "On this device" is a facet beside the status filters,
and the header's Downloads link is `/library?device=1`, which the facet reads
from the URL. Books whose audio is not on this device stay browsable,
searchable, taggable and sortable, are marked "Not on device", and are not
playable; byte size and "remove the download" survive in the merged view.

## Design system

- Design read: calm personal media player, not a dashboard.
- Dials: variance 4, motion 3, density 5.
- One cobalt accent over cool neutral surfaces, system-aware light/dark theme.
- Buttons are pill-shaped; panels and book surfaces use a consistent 14-16px radius.
- Motion is limited to state feedback and layout transitions, with reduced-motion support.
- Touch targets are at least 44px and core player actions are always visible.

## Code structure (post-convergence)

- `src/server/api/route-handler.ts`: the single seam for origin checks,
  session resolution, and zod validation; every API route composes it.
- `src/server/books/queries.ts` + `dto.ts`: centralized data access and the
  wire serialization that keeps client and server types identical.
- `src/lib/playback-core.ts`: pure playback decisions (chapter selection,
  smart rewind, start-position resolution, local device state), unit-tested.
- `src/components/player/`: the provider wires one audio element to focused
  hooks — progress persistence, sleep timer, Media Session, tab arbitration,
  playback history, transport/seek actions (`use-transport-actions.ts`) — with
  rendering kept in `full-player.tsx`/`mini-player.tsx`. Playback time lives in
  an external store (`playback-time-store.ts`) so timeupdate ticks don't
  re-render the player tree; chapter selection binary-searches on the hot path.
  The provider is the single sink for progress-conflict reconciliation.
- `src/lib/offline/` (`db`, `media-store`, `deletion-journal`, `library`,
  `account-purge`) + `local-import.ts`: the device-local media store and the
  in-browser import pipeline; `mirror.ts` + `sync-protocol.ts`: the library
  mirror and the wire guards for a pulled batch; `outbox.ts` +
  the `offline-sync/` modules: the outbox, coalescing, and idempotent replay.
- `src/server/sync/pull.ts` + `src/app/api/sync/pull/route.ts`: the cursored
  pull; `src/server/api/mutation-schemas.ts`: every mutation route's `.strict()`
  request shape, in one importable place.
- `src/components/library/`: `library-client.tsx` (the one library screen and
  the `data-launch-ready` contract) and `use-library-books.ts` (the local read
  and the post-paint revalidation); `src/lib/launch-revalidation.ts` gates when
  the network may be touched.
- `src/lib/wire.ts`: runtime guards at every client fetch boundary.
- Shared lib primitives: `keyed-lock.ts` (one keyed-lock implementation),
  `single-flight.ts` (single-flight replay wrapper), `format-bytes.ts`, and
  `app-keys.ts` (named device-storage keys and window events).
- `src/app/styles/`: the stylesheet split by surface, imported in cascade
  order from `globals.css`.

## Rejected alternatives

- MP3 blobs in Postgres: poor cost, range, backup, and scalability characteristics.
- Server object storage (local disk or S3-compatible): real money and real
  operational surface for bytes the user already owns as files; replaced by
  device-local storage with metadata sync and verified re-attach.
- Runtime schema push: violates ordered, reviewable migration requirements.
- Generic PWA runtime caching for audio: streaming would look downloaded when it is not.
- A prebuilt dashboard design system: wrong hierarchy for a focused consumer listening app.
- Native apps: outside the single-codebase PWA goal.
- A second Downloads screen: every capability it had is a facet of the one
  library, and two screens over the same rows is two places for the read path to
  drift.
- CRDTs, real-time sync, Background Sync, and SQLite-WASM: reasoning in
  `docs/local-first.md` section 13.

## Residual risks

- **The launch benchmark does not run on WebKit.** In Playwright 1.61.1,
  `webkit.launchPersistentContext` accepts `cache.put()` and lists the cache but
  returns nothing from `cache.match()`, from the page and from inside the
  service worker alike — the app's own worker cannot install there. The harness
  probes WebKit first on every run and falls through to a Chromium persistent
  context with iPhone 15 emulation, so iOS fidelity of the _launch_ path is not
  covered by those numbers. WebKit PWA coverage comes from
  `tests/e2e/iphone-pwa.spec.ts`, which uses a non-persistent context.
- **The queue drains only while the app is open.** iOS supports no Background
  Sync and will not wake a closed PWA, so an offline write reaches the server on
  the next foregrounded launch or reconnect and not before.
- **Evicted audio is unrecoverable** without re-importing the file. The MP3
  exists only on the device that imported it; the app keeps the book visible
  with its metadata, never lets it look playable, and re-import reattaches to
  the same book by fingerprint with progress, chapters, tags and collections
  intact.
- **The library can be one sync behind another device.** That is the explicit
  trade for a launch that does not depend on the network.
