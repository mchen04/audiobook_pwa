# Architecture

## Status

Decision record started 2026-07-09; last reconciled with the code on 2026-07-10
after the structural convergence pass. Update this document whenever executable
reality changes.

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
- Cache Storage + IndexedDB for the device-local audio library
- A native, versioned service worker for the offline shell and update lifecycle
- Vitest for unit/integration logic and `agent-browser` for end-to-end UI verification

## Why this stack

Next.js has current first-party App Router and PWA guidance and can keep private data and media authorization on the same origin. Drizzle supports Neon without hiding SQL or migrations. Better Auth supplies scrypt password hashing and cookie/session primitives that would be risky to recreate. A custom service worker is deliberately small because offline audio storage and conflict reconciliation need application-specific behavior rather than generic runtime caching.

## Runtime boundaries

```text
Browser UI
  -> playback engine (one HTMLAudioElement)
  -> IndexedDB offline library/media/mutation queue
  -> same-origin JSON and streaming APIs

Next.js server (metadata only — never audio bytes)
  -> auth/session boundary
  -> application services
  -> Drizzle/Postgres repository

Neon Postgres
  -> users/sessions
  -> books/media metadata/chapters
  -> progress revisions/listening sessions
  -> bookmarks, collections, tags
  -> rate-limit state
```

## Data rules

- Every private row is owned directly or transitively by one user.
- Queries scope by authenticated user and resource ID at the same boundary.
- Audio bytes and cover blobs never leave the user's devices; Postgres holds
  metadata only, including a versioned content fingerprint for duplicate
  detection and cross-device file verification. New imports use whole-file
  SHA-256; legacy sample fingerprints remain readable for existing books.
- Book deletion removes rows server-side and the local bytes client-side;
  account deletion cascades every row and wipes this device's local data.
- Progress uses device/session IDs and monotonic per-device sequence numbers. The server rejects duplicate/stale events while allowing an explicit user rewind.

## Media flow

1. Import happens in the browser: `music-metadata` parses the chosen file
   (shared pure interpreter in `src/domain/mp3.ts` — format validation,
   chapter normalization, artwork sniffing), and a streaming whole-file
   SHA-256 identifies the exact bytes without buffering the book in memory.
2. `POST /api/books/local` registers metadata only — validated title/author,
   duration, byte size, fingerprint, and the full chapter list (revalidated
   server-side, batch-inserted, capped at 10,000 chapters). A database-unique
   owner/fingerprint pair makes concurrent duplicate imports atomic; a match
   answers 409 with the existing book id for device reattachment.
3. The audio bytes go into this device's Cache Storage under an
   `/offline-media/<uuid>` URL (Blob-backed, nothing buffered in memory) with
   a per-user IndexedDB record; embedded cover art is stored beside it. If
   storing fails, the registration is rolled back by deleting the book.
4. Playback always serves from the device store through the service worker,
   which answers HTTP Range requests (206/416 parity-tested against the
   canonical parser). There is no server media route.
5. On a device that lacks the bytes, the player's media gate asks for the
   original MP3 and verifies byte size and fingerprint before attaching it —
   positions and bookmarks were already synced through Postgres.

## Offline model

- Service worker: versioned shell cache, install-time precache of the offline
  page and its chunks, offline navigation fallback, Range-capable serving of
  downloaded media, no automatic MP3 caching.
- Cache Storage holds the imported MP3 bytes (and covers); IndexedDB holds the
  per-user library records; localStorage holds user-scoped positions,
  preferences cache, and the offline progress/bookmark queues. Reads reconcile
  IndexedDB against Cache Storage so an OS-evicted media entry becomes an
  honest reattach flow instead of a broken player.
- Account deletion clears that user's local books, queues, positions, and
  preferences on the device; sign-out clears the active-user marker.
- Reconnect: queued mutations replay idempotently (device sequences for
  progress, client ids for bookmarks); the server resolves conflicts
  deterministically and stale events never move fresh positions.

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
  bookmarks — with rendering kept in `full-player.tsx`/`mini-player.tsx`.
- `src/lib/offline-library.ts` + `local-import.ts`: the device-local media
  store and the in-browser import pipeline; `offline-sync.ts`: mutation queues.
- `src/lib/wire.ts`: runtime guards at every client fetch boundary.
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
