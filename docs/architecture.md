# Architecture

## Status

Decision record started 2026-07-09; last reconciled with the code on 2026-07-17
after the performance and structural overhaul pass. Update this document whenever executable
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
  -> playback actions, collections, tags
  -> rate-limit state
```

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
  (including its transcript cues); account deletion cascades every row and
  wipes this device's local data.
- Progress uses device/session IDs and monotonic per-device sequence numbers. The server rejects duplicate/stale events while allowing an explicit user rewind.

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

## Offline model

- Service worker: versioned shell cache, install-time precache of the offline
  page and its chunks, offline navigation fallback, chunk-streamed Range
  serving of downloaded media, no automatic MP3 caching.
- Cache Storage holds the imported MP3 bytes (and covers); IndexedDB holds the
  per-user library records; localStorage holds user-scoped positions,
  preferences cache, the offline progress queue, and the capped playback-history
  ledger. Reads reconcile
  IndexedDB against Cache Storage so an OS-evicted media entry becomes an
  honest reattach flow instead of a broken player.
- Account deletion clears that user's local books, queues, positions, and
  preferences on the device; sign-out clears the active-user marker.
- Reconnect: queued mutations replay idempotently (device sequences for
  progress, client-generated UUIDs for playback actions); the server resolves
  conflicts deterministically and stale events never move fresh positions.

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
- `src/lib/offline/` (`db`, `media-store`, `deletion-journal`, `library`) +
  `local-import.ts`: the device-local media store and the in-browser import
  pipeline; `offline-sync.ts`: mutation queues.
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
