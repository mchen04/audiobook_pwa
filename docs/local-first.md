# Local-first architecture

Last reviewed against the implementation: 2026-07-28

Hark's library reads from the device, always. The network only syncs in the
background. There is no "am I online?" branch anywhere on the read path.

This note is the design contract. It was written before the sync engine, because
designing a sync engine in code first is how local-first projects lose data.

## 1. Why this is a completion, not a reversal

The audio already never leaves the device (`src/lib/local-import.ts` parses the
MP3 in the browser; `src/app/api/books/local/route.ts` receives metadata only;
`media_assets` has no storage key or URL column). The device therefore already
holds the only copy of the only irreplaceable data. Postgres holds metadata that
could be rebuilt from it. Making the device authoritative for reads finishes an
architecture that was already half-built.

## 2. What is mirrored, and what is not

Mirrored to IndexedDB (the app reads these locally and only locally):

| Entity                    | Local store         | Sync unit             |
| ------------------------- | ------------------- | --------------------- |
| books                     | `books`             | book aggregate        |
| chapters                  | `chapters`          | book aggregate        |
| media asset metadata      | `books` (embedded)  | book aggregate        |
| playback states           | `playbackStates`    | per book+device       |
| tags (vocabulary)         | `tags`              | user-level, full pull |
| book↔tag edges            | `bookTags`          | book aggregate        |
| collections               | `collections`       | user-level, full pull |
| collection↔book edges     | `collectionBooks`   | collection aggregate  |
| user preferences          | `preferences`       | user-level, LWW       |
| recent listening sessions | `listeningSessions` | append-only           |

Never mirrored — these stay server-authoritative:

- `user`, `session`, `account`, `verification`, `rate_limit`. Sessions must stay
  server-authoritative; a device may not mint its own auth.
- `playback_action_receipts`. That is the server's idempotency ledger and only
  the server may write it.

Never moved to the server, ever: **audio bytes and transcript payloads**. They
live in Cache Storage / IndexedDB on the device that imported them, and there is
no route capable of accepting or serving them. This is a hard boundary, not a
default.

## 3. The sync unit is the book aggregate

`books`, `mediaAssets`, `collections`, `playbackStates` and `userPreferences`
carry `updatedAt`. `chapters`, `tags`, `bookTags`, `collectionBooks` and
`listeningSessions` do not.

Rather than add five columns and backfill them, the **book aggregate** is the
unit of change: any mutation to a book's chapters or tag edges bumps that book's
`books.updatedAt`. A pull that sees a changed book re-pulls that book's chapters
and tag edges wholesale. The same rule applies to a collection and its
membership edges.

This is deliberate. It makes the cursor trivially correct, keeps conflict
resolution reasoning at one granularity, and avoids a partially-applied child
row ever being visible without its parent.

Consequence that must be honored by every write path: **a mutation that only
touches a child table must still bump the parent's `updatedAt`**, or the change
will never propagate to another device. Any new mutation route that forgets this
is a sync bug, and the two-device convergence test exists to catch it.

That consequence is load-bearing for **books** and, today, only for books. Book
aggregates are cursored, so `books.updatedAt` is the only thing that puts a
chapter or tag-edge change into another device's incremental pull. Collections
are pulled in full and uncursored, so a missing `collections.updatedAt` bump does
not currently break propagation — which means propagation cannot be used as
evidence that the bump happened. Assert the timestamp directly. A test that
infers the bump from "the other device saw it" passes even when the bump is gone,
and would stop protecting anything the moment collections became cursored.

Tag vocabulary and collection lists are small and user-level, so they are pulled
in full on every sync rather than cursored.

## 4. Local schema

Two IndexedDB databases, kept separate on purpose: state and outbox have
different failure modes, and merging them would mean migrating both at once.

### `chapterline-offline-v1` — device state, version 6 → 7

Existing stores are untouched and keep their data: `downloads`, `transcripts`,
`deletions`, `cacheEntries`.

Version 7 adds the mirror:

- `books` — key `userId:bookId`, indexes `by-user`, `by-user-updated`
- `chapters` — key `userId:bookId:paddedIndex`, index `by-user-book`
- `playbackStates` — key `userId:bookId`, index `by-user`
- `tags` — key `userId:tagId`, index `by-user`
- `bookTags` — key `userId:bookId:tagId`, indexes `by-user`, `by-user-book`
- `collections` — key `userId:collectionId`, index `by-user`
- `collectionBooks` — key `userId:collectionId:bookId`, indexes `by-user`,
  `by-user-collection`
- `preferences` — key `userId`
- `listeningSessions` — key `userId:sessionId`, index `by-user-book`
- `syncMeta` — key `userId`, holds the pull cursor and last-sync time

Every store is keyed by `userId` first and carries a `by-user` index. That is
what makes account-switch purge a bounded, provable operation rather than a
best-effort sweep.

The version-7 upgrade is **additive only**. It creates stores; it does not
rewrite or delete existing records. A device that already holds downloads,
transcripts and a pending deletion journal comes through with all of it intact,
and the mirror simply starts empty and fills on first pull.

#### Upgrade steps must be awaited

Both existing cursor sweeps are fire-and-forget:

- `db.ts` — `void downloads.openCursor().then(...)` (the legacy-bookmark strip)
- `offline-sync.ts` — `void mutations.openCursor().then(...)` (the legacy purge)

The `void` means a rejection inside the sweep becomes an unhandled rejection
instead of aborting the version-change transaction. The new version number still
commits, and because each sweep is guarded by `oldVersion < N` it can never run
again.

Today both sweeps only _delete_ legacy rows, so a silent partial sweep leaves
stale-but-harmless data. That stops being true the moment an upgrade **rewrites**
data. Any new upgrade step must be `await`ed inside `upgrade()` before the
version is bumped, so a failure aborts the transaction and the upgrade is retried
rather than half-committed. Copying the existing `void` pattern into a
data-rewriting migration is how this design would lose user data.

### `chapterline-sync-v1` — the outbox, version 3 → 4

Today `mutations` holds only `kind: "progress"`. Version 4 generalizes it to
every mirrored mutation. `sequences` (per-book device high-water marks) is
unchanged and must never be reset — those values order replay, and losing them
loses writes.

## 5. The outbox

Record shape:

```
{
  key:         string,   // dedupe/coalesce identity, see below
  userId:      string,
  kind:        "progress" | "import" | "metadata" | "tag" | "collection"
             | "archive" | "delete" | "history",
  entityId:    string,   // bookId / collectionId
  payload:     object,   // the intended change
  mutationId:  string,   // uuid, the idempotency key sent to the server
  deviceId:    string,
  deviceSequence: number,
  queuedAt:    number,
  attempts:    number,
}
```

Rules:

1. **Journal intent before acting.** The outbox row is written **first**, and the
   optimistic mirror update only after it. Each half is individually atomic.

   An earlier draft of this note required both in one IndexedDB transaction.
   That is not implementable: the outbox lives in `chapterline-sync-v1` and the
   mirror in `chapterline-offline-v1`, IndexedDB has no cross-database
   transaction, and section 4 keeps the two databases separate on purpose.

   Ordering carries the guarantee instead, and it is the same ordering
   `deletion-journal.ts` already proves. A crash between the two halves leaves
   an outbox row whose local projection has not been applied — recoverable, and
   the server still learns about the write. The forbidden state is the reverse:
   a mirrored change the user can see with no queued write behind it, which
   would be a silent lost write. Never write the mirror first.

2. **Idempotent on replay.** `mutationId` is generated once, at queue time, and
   reused on every retry. The server dedupes on it. Replaying a mutation the
   server already applied is a no-op, not a double-apply.
3. **Coalescing is by `key`, and only where it is safe.** Progress for a given
   book+device coalesces to the highest `deviceSequence` (existing behavior).
   Tag and collection edge changes coalesce per edge. Renames coalesce per book.
   `import`, `delete` and `history` **never** coalesce — each is a distinct
   event and dropping one loses a write.
4. **Retry on reconnect and on launch, never in the background.** iOS does not
   support Background Sync and will not wake a closed PWA. The queue drains when
   the app is open. No UI may imply otherwise.
5. **Failure classification is inherited**, not reinvented:
   `isRetryableMutationStatus` and `shouldRetainMutation` in `offline-sync.ts`
   already encode it. 401/403 retain (the session may come back). 4xx other than
   409 is terminal. 409 goes to conflict reconciliation.

### 5.4 A delete supersedes an unsent registration of the same file

The outbox drains in key order with several rows in flight, which is NOT the
order the user expressed their intents. `delete` sorts before `import`, so a
delete could land, release the fingerprint, and let a registration queued
_earlier_ find the fingerprint free and re-create the book the user had already
deleted. The fuzz found this on seed 20260105 and called it what it is: a
resurrection. Nothing was lost in transit — the delete was undone by an intent
the user had already superseded.

So `commitBookDeletion` drops any unsent registration of the same file, in the
same transaction that journals the delete: no window in which both rows exist,
and no ordering left to get right. It links them two ways, because a user can be
looking at either kind of row — by book id (a device-only book the library
projects from a download record) and by fingerprint (read from the mirror, never
sent on the wire). A registration queued _after_ a delete is kept: re-importing
something you deleted is a new intent, not a stale one.

### 5.5 When the server renames a book mid-flight

A registration queued offline carries the id this device minted. If the server
already owns that fingerprint it answers 409 with the canonical id, and the local
identity moves onto it (§10). Two consequences that are easy to miss, and both
were bugs:

- **Queued rows naming the abandoned id must be re-addressed too**, with the
  production key builders rather than hand-built strings, or every edit, tag,
  archive and delete queued before the merge replays against a book the server
  has never heard of and settles as terminal. Progress is re-stamped from the
  _target's_ sequence counter, because the server discards a sequence at or below
  its high-water mark for (user, book, device) **and answers 200** — a carried-over
  sequence is a write that reports success and vanishes.
- **A 404 is not terminal while a registration for that book is still queued.**
  `archive`, `collection`, `delete` and `history` all sort ahead of `import`, so
  they reach the server before the merge is knowable. Dropping them there loses
  the user's intent, including their delete.

### 5.6 Preferences are the one write that is not an outbox row

`savePreferences` keeps its pending revision in the localStorage envelope rather
than the outbox. It is still journalled, drained and reported — the sign-out
drain enumerates it alongside the outbox and the playback queue, and reports it
if the server will not take it — but the mechanism differs, and this note would
be lying if it claimed otherwise. Moving it onto a real outbox kind is the
cleaner end state.

## 6. Pull

`GET /api/sync/pull?since=<iso>` returns everything that changed for the signed-in
user since the cursor, as the book/collection aggregates of section 3, plus the
full tag vocabulary, collection list, preferences, and recent listening sessions.

It reuses the query shape already proven in
`src/server/account/export-stream.ts`, which reads exactly this set of tables
under a read-only repeatable-read transaction.

- Cursor is `max(updatedAt)` observed in the response, stored in `syncMeta`.
- The cursor is advanced **only after** the whole batch has been committed to
  IndexedDB, so an interrupted pull re-fetches rather than skips.
- Deletions are conveyed as explicit tombstones, not absence. Absence cannot be
  distinguished from "not in this page".
- A new index on `books (owner_id, updated_at, id)` ships as a drizzle migration
  to keep the cursor scan cheap.

Pull runs on launch (after paint, never before) and on reconnect.

## 7. Conflict resolution — extend, do not replace

The repo already has a working model and this design adds no second one:

- `playback_states` carries `deviceId`, `deviceSequence`, `eventOccurredAt`;
  `playback_device_sequences` holds per-device high-water marks;
  `playback_action_receipts` is the durable idempotency ledger.
- `src/server/playback/progress-policy.ts` and `listening-session-policy.ts`
  hold the rules. `PROGRESS_CONFLICT_EVENT` already surfaces conflicts to the UI.

Per entity:

| Entity                                  | Rule                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| playback state                          | existing device-sequence policy, unchanged                                                                                    |
| listening sessions                      | append-only, dedupe by id; existing session policy                                                                            |
| book metadata (title, author, archived) | last-writer-wins on `updatedAt`, ties broken by `deviceId`                                                                    |
| tag / collection edges                  | add-wins; an explicit remove carries a tombstone that outranks a concurrent add only when its `updatedAt` is newer            |
| preferences                             | last-writer-wins on `updatedAt`                                                                                               |
| import (new book)                       | fingerprint-unique; a duplicate registration returns 409 with `existingBookId` and is treated as a merge, never a second book |

Conflicts are surfaced through the existing `PROGRESS_CONFLICT_EVENT`
mechanism rather than a parallel channel.

## 8. The launch path

The whole point. Warm launch must paint real library content without touching
the network, so that a 3000ms cold database and airplane mode produce the same
number as wifi.

Icon tap → painted content:

0. The install handler declares a **static route** for the manifest's
   `start_url` (`/library?source=pwa`), so the browser answers that one
   navigation straight from Cache Storage **without starting the service worker
   at all**. This exists because booting a worker to ask it about a navigation
   makes Chromium hedge the wait by speculatively fetching the same document:
   the paint never waits for it, but the server renders `/library` and runs its
   queries on every cold launch and the answer is discarded.

   Two details are load-bearing, because a routing **miss goes to the network**
   rather than falling back to the `fetch` handler. The condition matches the
   start_url exactly — pathname _and_ search — so every other navigation is left
   to `serveNavigation`, which is not query-sensitive; and `precacheShell`
   stores the shell under that exact key so the lookup hits. Writing the rule
   for a bare `/library` put the whole launch document back on the wire
   (measured: 5.4 KB per launch, cold-database p95 3426ms). `addRoutes` is
   Chromium-only and guarded; elsewhere step 1 is unchanged and authoritative.

1. The service worker serves the `/library` document **from Cache Storage,
   cache-first**. No network on the critical path, so no network profile can
   change this step's cost.
2. That cached document is a **user-agnostic shell**. It contains no book data
   and no user identity — which is what makes caching it safe across accounts.
   The server page therefore renders no user rows into HTML.
3. The client reads the mirror from IndexedDB and renders real book cards.
   `data-launch-ready` is set at this point, and **only** when real content or
   the genuine empty state is on screen — never when a skeleton mounts.
4. _After_ paint, revalidation runs: session check and `GET /api/sync/pull`.
   Results patch into the already-rendered list in place — no flash, no layout
   jump, no scroll reset.

Session handling under a cached shell:

- The cached shell is served without consulting the server, so `requireSession()`
  does not run on a warm launch. That is intended: it is what removes Postgres
  from the paint path.
- The client checks `ACTIVE_USER_KEY` before rendering the mirror. No active
  user → `/login`.
- Revalidation answering 401/403 → `/login`, **without purging**. An expired or
  revoked session must never strand the user on a cached library.

  An earlier draft of this note said "purge and `/login`". That would have been a
  data-loss bug: the purge path deletes downloads and their media, and per
  section 10 those MP3s exist nowhere else. A session timing out overnight is a
  routine event, and it must not cost the user every audiobook on the device.

  Privacy is still closed, one step later and by the right mechanism: the mirror
  that survives belongs to the account that is still signed in on this device,
  and section 11's sign-in purge removes every _other_ account's data before a
  different user can see anything. Expiry is not a trust boundary; a new sign-in
  is.

Consequences that must hold:

- **Zero Postgres queries on the warm-launch critical paint path.** Proven by a
  query counter around the postgres client, not by argument. The benchmark also
  asserts zero server document requests of any kind during a launch, which is
  stricter: it catches a request the paint does not wait for but the server
  still pays for, which is exactly how the speculative preload above was found.
- **The launch must paint the user's real library, not merely something.** The
  benchmark asserts the readiness marker says `books`, counts the rendered
  cards, and requires the document to arrive as `cache-storage` with an empty
  transfer. Without that last part a device whose mirror had been evicted
  painted "Bring your first audiobook" to an account owning 1000 books and
  scored the best numbers ever recorded.
- First install has no cache, so it must race the network against a bounded
  timeout rather than hanging on a fetch that a weak-but-alive connection will
  never reject. The current unbounded `fetch(request).catch(...)` is exactly the
  bug that produces a blank screen instead of a fallback.
- `use-library-books.ts` currently skips fetching on first render. Once the
  first paint comes from local data, that skip is a correctness bug and the
  revalidation must exist.

### 8.1 Offline import needs its code cached, not just its data

The import path reaches its MP3 parser through `await import("music-metadata")`,
that package reaches the parser that does the work through a SECOND dynamic
import which only runs when something is actually parsed, the hasher is a third,
and the fingerprint runs in a **Worker** whose script no `import()` can reach at
all. A code-split chunk is not referenced by the cached shell, so `precacheShell`
never sees it, and the service worker's runtime caching only stores what has
actually been requested — which is never, until someone picks a file.

The consequence was that importing a book with no network had never worked: it
failed with "Failed to load chunk" where the audiobook should have been, which
also made §10's eviction recovery unreachable exactly when it is needed. So:

- `pwa-register.tsx` warms the parser after paint by parsing a synthesized
  MPEG-1 Layer 3 frame through the real `parseBlob`, so whatever chunk an MP3
  needs is the chunk that gets fetched, with no assumption about the package's
  internals. It marks `data-import-ready` when that and the hasher have resolved,
  in the same spirit as `data-launch-ready` — otherwise the state is invisible
  and a test can only guess at it with a sleep.
- The Worker cannot be warmed, so `fingerprintMedia` falls back to hashing
  inline when its script will not load. Slower, and better than being unable to
  add a book.

Anything new on a path that must work offline gets the same audit: every
`await import(` and every `new Worker(` is a network dependency until proven
otherwise.

## 9. One library UI

`/library` is the only library UI. "On this device" becomes a facet alongside
the existing status filters, not a second screen. `/offline` redirects into the
unified library.

- Books whose audio is not on this device stay browsable, searchable, taggable
  and sortable. They are visibly marked and never look playable.
- Every capability of the old Downloads screen survives in the merged view,
  including byte size and removing a download.
- Search, status filters, tag filters, sort, view toggle and the continue card
  all operate on local data, so they work identically with the network off.

## 10. Eviction and storage pressure

Safari reclaims script-writable storage from disused origins.
`navigator.storage.persist()` is the mitigation and
`src/lib/offline/media-store.ts` already requests persistence, checks
`navigator.storage.estimate()`, and handles `QuotaExceededError`. The mirror
reuses that machinery rather than bypassing it.

Two different losses, two different recoveries:

- **Mirror evicted** — recoverable. Metadata re-pulls from Postgres. The app
  detects the empty mirror, re-pulls, and carries on.
- **Audio evicted** — _not_ recoverable from anywhere. The MP3 exists only on
  this device (section 2). The app must detect it, keep the book visible with
  its metadata intact, never let it look playable, and say plainly that the file
  must be re-imported.

Re-import must be cheap and lossless, and the machinery already exists: media is
fingerprinted with sha256, `media_assets` is unique on
(owner, fingerprintKind, fingerprint), and duplicate registration returns 409
with `existingBookId` plus the saved position, which `local-import.ts` already
follows. Re-importing an evicted book must reconnect to the **same** book and
restore progress, chapters, tags and collections — never create a duplicate,
never reset the position.

Storing the file's path cannot rescue this: `<input type="file">` yields a
`File`, never a path, and File System Access is unavailable in Safari on iOS.
Re-picking the file is the only recovery, which is why it must be lossless.

## 11. Account lifecycle

A cached page, mirrored row, or downloaded file from one account must never be
readable by another.

Purge runs on **both** sign-out and sign-in, and covers: every mirror store by
`by-user` index, the outbox, Cache Storage entries for pages and media,
localStorage keys for that user, and `ACTIVE_USER_KEY`. Purging on sign-in as
well as sign-out is what protects against a crash between the two.

The two purges have deliberately different targets:

- **Sign-out** purges the account that is leaving.
- **Sign-in** purges every account _other_ than the one signing in — never the
  incoming account's own data.

That asymmetry is load-bearing. Purging the incoming account's own data on every
login would delete its downloaded audio, and per section 1 those MP3s exist
nowhere else in the world — the server has never held the bytes. Wiping every
other account still delivers the property this section exists for (B can never
read A's rows, because the next sign-in finishes any cleanup a crash
interrupted) without destroying the only copy of something irreplaceable.

The cached shell is user-agnostic and holds no user data, so it may survive an
account switch. Every store that does hold user data is keyed by `userId`, which
is what makes the purge provable rather than best-effort.

## 12. Migration for devices that already have data

Non-negotiable: a device that already holds downloads, transcripts and a pending
deletion journal must come through the upgrade with all of it intact.

- The version-7 upgrade is additive; it creates stores and rewrites nothing.
- Existing `downloads` records remain the source of truth for "audio is on this
  device" and are joined to mirrored books by `bookId`.
- The first pull after upgrade populates the mirror. Until it completes, the
  library renders from `downloads` alone, so an offline device that upgrades
  still shows its books.
- The deletion journal keeps retrying on next load, unchanged.

## 13. What this design deliberately does not do

- No CRDTs or operational transform. The existing last-writer-wins model with
  device sequences and idempotency receipts is extended instead.
- No real-time sync, websockets or push. Launch, reconnect, and post-mutation is
  enough.
- No Background Sync / Periodic Background Sync — iOS support is poor and the
  deletion-journal retry-on-next-load pattern is the precedent.
- No audio on the server, and no object storage. This reverses the privacy
  promise and is out of scope.
- No SQLite-WASM. A megabyte of WASM instantiating before the first book can be
  read fights the sub-500ms bar; iOS restricts OPFS sync access to Workers; and
  a few hundred books filter in JavaScript in well under a millisecond.

## 14. Residual risks

- **Staleness.** The library can be up to one sync interval behind another
  device. That is the explicit trade for network-independent launch.
- **Queue drains only while the app is open.** A mutation made offline reaches
  the server on the next foregrounded launch or reconnect, not before. No UI may
  imply background delivery.
- **Evicted audio is unrecoverable** without a re-import, by design.
