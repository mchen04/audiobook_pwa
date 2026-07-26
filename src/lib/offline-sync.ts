import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";

import { ACTIVE_USER_KEY, PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
import { readLocalProgress } from "@/lib/playback-core";
import { singleFlight } from "@/lib/single-flight";
import { withKeyedLock } from "@/lib/keyed-lock";
import { runBounded } from "@/lib/run-bounded";

const DATABASE_NAME = "chapterline-sync-v1";
export const SYNC_DATABASE_VERSION = 5;
export const REPLAY_PAGE_SIZE = 100;
export const REPLAY_CONCURRENCY = 4;
const activeReplays = new Map<string, Promise<void>>();

/**
 * The outbox: every mutation this device has made but the server has not yet
 * acknowledged. It is the only thing standing between a user write and a lost
 * write, so nothing is ever removed from it except on a server answer that
 * proves the write landed (or is permanently unacceptable).
 *
 * Design contract `docs/local-first.md` sections 5 and 7.
 */

export type MutationKind =
  "progress" | "import" | "metadata" | "tag" | "collection" | "archive" | "delete" | "history";

export type QueuedMutation = {
  /** Coalesce identity. Two rows sharing a key are the same intent. */
  key: string;
  userId: string;
  kind: MutationKind;
  /** bookId or collectionId. */
  entityId: string;
  /** The intended change, already in the shape the route accepts. */
  payload: Record<string, unknown>;
  /** Generated once at queue time and reused on every retry. */
  mutationId: string;
  deviceId: string;
  deviceSequence: number;
  queuedAt: number;
  attempts: number;
};

export type QueuedProgress = {
  userId: string;
  bookId: string;
  deviceId: string;
  deviceSequence: number;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  eventOccurredAt: string;
};

/** The legacy v1–v3 record, read only by the v4 upgrade. */
type LegacyProgressMutation = {
  key: string;
  userId: string;
  kind: "progress";
  entry: QueuedProgress;
};

interface SyncDatabase extends DBSchema {
  mutations: {
    key: string;
    value: QueuedMutation;
    indexes: { "by-user": string; "by-user-key": [string, string] };
  };
  sequences: {
    key: string;
    value: SequenceRow;
  };
}

/**
 * A per-book replay high-water mark.
 *
 * From version 5 the key is `userId:bookId` and the row names its owner, so an
 * account purge can sweep it by key range like every other store. Rows written
 * before then — or written while no account was signed in — keep the bare
 * `bookId` key and carry no `userId`; both shapes are read, and a legacy row is
 * folded into its scoped key the next time the book is written.
 *
 * The floor row (`SEQUENCE_FLOOR_KEY`) is neither: one integer, no owner and no
 * book. See `purgeDeviceSequencesForUser`.
 */
type SequenceRow = { key: string; userId?: string; bookId?: string; value: number };

type SyncDb = IDBPDatabase<SyncDatabase>;

/**
 * Coalescing policy, exactly as the design contract states it.
 *
 * - `sequence`: progress for one book+device collapses to the highest
 *   `deviceSequence`; an out-of-order arrival is dropped, never applied over a
 *   newer one.
 * - `replace`: the latest intent for this entity wins outright (a rename, an
 *   archive flip, one tag edge, one collection edge).
 * - `never`: each row is a distinct event. `import`, `delete` and `history`
 *   carry a unique key so no two of them can ever collapse — dropping one is a
 *   lost write, not a saved round trip.
 */
export const MUTATION_COALESCING: Record<MutationKind, "sequence" | "replace" | "never"> = {
  progress: "sequence",
  metadata: "replace",
  archive: "replace",
  tag: "replace",
  collection: "replace",
  import: "never",
  delete: "never",
  history: "never",
};

function database() {
  return openDB<SyncDatabase>(DATABASE_NAME, SYNC_DATABASE_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const mutations = db.createObjectStore("mutations", { keyPath: "key" });
        mutations.createIndex("by-user", "userId");
        mutations.createIndex("by-user-key", ["userId", "key"]);
        db.createObjectStore("sequences", { keyPath: "key" });
        return;
      }
      if (oldVersion < 2) {
        const mutations = transaction.objectStore("mutations");
        let cursor = await mutations.openCursor();
        while (cursor) {
          const legacy = cursor.value as LegacyProgressMutation | { kind: string };
          if (legacy.kind !== "progress") await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 3) {
        transaction.objectStore("mutations").createIndex("by-user-key", ["userId", "key"]);
      }
      if (oldVersion < 4) {
        // The first upgrade in this database that *rewrites* rows rather than
        // only dropping them, so it is awaited: a rejection here aborts the
        // version-change transaction and the upgrade is retried on the next
        // open instead of committing a half-migrated outbox. Each row is a
        // user write that has not reached the server, so losing one here is
        // indistinguishable from losing the write itself.
        const mutations = transaction.objectStore("mutations");
        let cursor = await mutations.openCursor();
        while (cursor) {
          await cursor.update(
            migrateLegacyMutation(
              cursor.value as unknown as LegacyProgressMutation | QueuedMutation,
            ),
          );
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 5) {
        await attributeSequencesToActiveUser(transaction);
      }
    },
  });
}

type UpgradeTransaction = IDBPTransaction<
  SyncDatabase,
  StoreNames<SyncDatabase>[],
  "versionchange"
>;

/**
 * v4 → v5. Attributes each bare `bookId` counter to the signed-in account so an
 * account purge can sweep it, and preserves its value exactly.
 *
 * Awaited, like the v4 step, so a failure aborts the version-change transaction
 * and the upgrade is retried rather than committing half-attributed.
 *
 * Two properties make this safe to run on a device mid-flight:
 *
 * - **Nothing is dropped when the owner is unknown.** With no signed-in account
 *   there is no honest attribution to make, so the rows are left exactly as
 *   they are and `nextDeviceSequence` keeps reading them through its bare-key
 *   fallback. A tidier migration that discarded them would reset this device's
 *   counters, and a counter that restarts below the server's high-water mark
 *   loses every write until it catches up.
 * - **A value can only rise.** The scoped row takes the maximum of whatever is
 *   already there and the value being carried across, so re-running this step
 *   over a partially attributed store cannot lower a counter.
 *
 * The store is snapshotted with `getAll` rather than walked with a cursor,
 * because the rewrite changes each row's primary key: a cursor could otherwise
 * visit a row this loop had just inserted ahead of it and attribute it twice.
 */
async function attributeSequencesToActiveUser(transaction: UpgradeTransaction): Promise<void> {
  const owner = activeUserId();
  if (!owner) return;
  const store = transaction.objectStore("sequences");
  for (const row of await store.getAll()) {
    if (row.userId !== undefined || row.key === SEQUENCE_FLOOR_KEY) continue;
    const scoped = deviceSequenceKey(owner, row.key);
    const existing = await store.get(scoped);
    await store.put({
      key: scoped,
      userId: owner,
      bookId: row.key,
      value: Math.max(existing?.value || 0, row.value),
    });
    await store.delete(row.key);
  }
}

/**
 * v3 → v4. The queued intent is preserved exactly — same book, same device,
 * same sequence, same position — only re-expressed in the general record shape.
 *
 * `mutationId` is derived deterministically from the identity the legacy row
 * already carried rather than minted fresh, so re-running the upgrade (or
 * running it on two tabs) cannot produce two different idempotency keys for
 * one queued write. `queuedAt` is 0 because the legacy row never recorded it;
 * nothing orders on it, and inventing `Date.now()` would claim a fact the
 * record does not contain.
 */
export function migrateLegacyMutation(
  row: LegacyProgressMutation | QueuedMutation,
): QueuedMutation {
  if (!("entry" in row)) return row;
  const { entry } = row;
  return {
    key: row.key,
    userId: row.userId,
    kind: "progress",
    entityId: entry.bookId,
    payload: progressPayload(entry),
    mutationId: `legacy:${row.key}:${entry.deviceSequence}`,
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    queuedAt: 0,
    attempts: 0,
  };
}

function progressPayload(entry: Omit<QueuedProgress, "userId">): Record<string, unknown> {
  return {
    positionMs: Math.round(entry.positionMs),
    playbackRate: entry.playbackRate,
    completed: entry.completed,
    eventOccurredAt: entry.eventOccurredAt,
  };
}

export function newMutationId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Coalesce keys
// ---------------------------------------------------------------------------

/** Unchanged from v1 so rows queued by an older build keep their identity. */
export function progressMutationKey(
  entry: Pick<QueuedProgress, "userId" | "bookId" | "deviceId">,
): string {
  return `${entry.userId}:progress:${entry.bookId}:${entry.deviceId}`;
}

export function metadataMutationKey(userId: string, bookId: string): string {
  return `${userId}:metadata:${bookId}`;
}

export function archiveMutationKey(userId: string, bookId: string): string {
  return `${userId}:archive:${bookId}`;
}

/** One key per edge, so two edits to the same edge collapse and no other pair does. */
export function tagMutationKey(userId: string, bookId: string, tagName: string): string {
  return `${userId}:tag:${bookId}:${tagName.toLowerCase()}`;
}

export function collectionMutationKey(
  userId: string,
  collectionId: string,
  bookId: string,
): string {
  return `${userId}:collection:${collectionId}:${bookId}`;
}

/**
 * Distinct-event keys. The `mutationId` in the key is what makes coalescing
 * impossible for these three kinds: no second row can ever collide with them.
 */
export function eventMutationKey(
  userId: string,
  kind: "import" | "delete" | "history",
  entityId: string,
  mutationId: string,
): string {
  return `${userId}:${kind}:${entityId}:${mutationId}`;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export type MutationDraft = Omit<QueuedMutation, "mutationId" | "queuedAt" | "attempts"> & {
  mutationId?: string;
  queuedAt?: number;
};

export function buildMutation(draft: MutationDraft): QueuedMutation {
  return {
    ...draft,
    mutationId: draft.mutationId || newMutationId(),
    queuedAt: draft.queuedAt ?? Date.now(),
    attempts: 0,
  };
}

/**
 * Journals one intent. Returns the row that is now durable — which is the
 * existing row when an out-of-order progress event was dropped, so a caller can
 * never believe it queued something the outbox refused.
 */
export async function queueMutation(mutation: QueuedMutation): Promise<QueuedMutation> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const existing = await transaction.store.get(mutation.key);
  const winner = resolveCoalescing(existing, mutation);
  if (winner !== existing) await transaction.store.put(winner);
  if (winner === mutation && mutation.kind === "delete") {
    await dropSupersededImports(transaction.store, mutation);
  }
  await transaction.done;
  return winner;
}

type MutationStore = IDBPTransaction<SyncDatabase, ["mutations"], "readwrite">["store"];

/**
 * A delete supersedes an UNSENT import of the same file.
 *
 * Deleting a book and re-picking its MP3 are two intents about one file, and
 * the outbox replays rows in key order with four in flight — not in the order
 * the user expressed them. So a registration queued before the delete lands
 * after it, finds the fingerprint free because the delete just released it, and
 * creates the book again. The user's delete is not lost in transit; it is
 * undone by an intent they had already superseded, and the book comes back.
 *
 * Resolving it here rather than at replay is what makes it deterministic: this
 * runs inside the SAME transaction that journals the delete, so there is no
 * window in which both rows exist and no ordering to get right afterwards.
 *
 * Two ways a queued registration is recognised as being about the deleted book,
 * because there are two ways the user can be looking at one. `payload.bookId`
 * matches the row the import itself created on this device — the "device-only"
 * book the library projects from a download record before any pull mentions it.
 * The fingerprint matches the other case: a re-import of a book this device
 * already knows, where the registration carries an id the server will discard.
 */
async function dropSupersededImports(
  store: MutationStore,
  deletion: QueuedMutation,
): Promise<void> {
  const fingerprint =
    typeof deletion.payload.fingerprint === "string" ? deletion.payload.fingerprint : null;
  let cursor = await store.index("by-user").openCursor(deletion.userId);
  while (cursor) {
    const row = cursor.value;
    const supersedes =
      row.kind === "import" &&
      (row.payload.bookId === deletion.entityId || (!!fingerprint && row.entityId === fingerprint));
    if (supersedes) await cursor.delete();
    cursor = await cursor.continue();
  }
}

function resolveCoalescing(
  existing: QueuedMutation | undefined,
  next: QueuedMutation,
): QueuedMutation {
  if (!existing) return next;
  // A `never` kind cannot reach here with a different row: its key embeds a
  // unique mutationId. Re-queueing the identical id is the caller retrying the
  // same intent, which must stay one event.
  if (MUTATION_COALESCING[next.kind] === "never") return existing;
  if (MUTATION_COALESCING[next.kind] === "sequence") {
    return existing.deviceSequence <= next.deviceSequence ? next : existing;
  }
  return next;
}

/**
 * One progress event in outbox form. Shared by the queue-only path and by
 * `offline/outbox.ts#commitProgress`, so the row a replay sends and the row the
 * mirror is projected from are assembled once, from the same builder.
 */
export function buildProgressMutation(entry: QueuedProgress): QueuedMutation {
  return buildMutation({
    key: progressMutationKey(entry),
    userId: entry.userId,
    kind: "progress",
    entityId: entry.bookId,
    payload: progressPayload(entry),
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
  });
}

export async function queueProgress(entry: QueuedProgress): Promise<void> {
  await queueMutation(buildProgressMutation(entry));
}

export function toProgressBody(entry: Omit<QueuedProgress, "userId">): string {
  return JSON.stringify({
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    ...progressPayload(entry),
  });
}

export function withProgressMutationLock<T>(
  bookId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(`chapterline:progress:${bookId}`, operation);
}

/**
 * The highest sequence this device has ever issued, for any book and any
 * account. It carries no `userId` and no `bookId` — it is one integer that
 * identifies nobody — which is why it may survive an account purge when the
 * per-book counters may not.
 *
 * It exists for exactly one reason. The server discards a progress write whose
 * `deviceSequence` is not above `playback_device_sequences.last_sequence` for
 * (user, book, device), and answers 200 while doing so. If an account purge
 * simply deleted this device's counters, the same account signing back in would
 * restart at 1 against a server that remembers 42, and every write until it
 * climbed past 42 would be silently dropped. Raising this floor as the counters
 * are deleted means the next sequence issued is above anything the server can
 * already hold, so the counters can be purged without a single lost write.
 */
const SEQUENCE_FLOOR_KEY = " device-sequence-floor";

/** `userId:bookId`. Book ids are uuids, so the separator is unambiguous. */
export function deviceSequenceKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}

function activeUserId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    // A device with storage disabled still has to be able to play.
    return null;
  }
}

/**
 * Issues the next sequence for a book, and never issues one that is not
 * strictly greater than every value this device has previously recorded for it.
 *
 * The maximum is taken across the scoped key, the pre-v5 bare key and the
 * device floor, so no combination of a half-run migration, a missing
 * `ACTIVE_USER_KEY`, or an account purge can hand back a number the server has
 * already seen. `userId` is optional because the sync harness and the player
 * both call this with the book alone; the active account is the fallback.
 */
export async function nextDeviceSequence(bookId: string, userId?: string): Promise<number> {
  const owner = userId || activeUserId();
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const store = transaction.store;
  const scoped = owner ? deviceSequenceKey(owner, bookId) : null;

  const [scopedRow, legacyRow, floorRow] = await Promise.all([
    scoped ? store.get(scoped) : Promise.resolve(undefined),
    store.get(bookId),
    store.get(SEQUENCE_FLOOR_KEY),
  ]);
  const next = Math.max(scopedRow?.value || 0, legacyRow?.value || 0, floorRow?.value || 0) + 1;

  if (scoped) {
    await store.put({ key: scoped, userId: owner!, bookId, value: next });
    // Fold the unattributed row in only once its replacement holds a value at
    // least as high, so the counter cannot dip through the gap.
    if (legacyRow) await store.delete(bookId);
  } else {
    await store.put({ key: bookId, value: next });
  }
  await transaction.done;
  return next;
}

/**
 * The last sequence issued for this book, or 0. The device floor is
 * deliberately excluded: callers ask this to find out whether a newer event for
 * *this book* has been queued since, and another book's counter is not that.
 */
export async function currentDeviceSequence(bookId: string, userId?: string): Promise<number> {
  const owner = userId || activeUserId();
  const db = await database();
  const transaction = db.transaction("sequences", "readonly");
  const [scopedRow, legacyRow] = await Promise.all([
    owner ? transaction.store.get(deviceSequenceKey(owner, bookId)) : Promise.resolve(undefined),
    transaction.store.get(bookId),
    transaction.done,
  ]);
  return Math.max(scopedRow?.value || 0, legacyRow?.value || 0);
}

/**
 * Removes one account's replay counters, raising the device floor to the
 * highest value being removed in the SAME transaction.
 *
 * Either both happen or neither does. A purge that deleted the counters without
 * raising the floor would reset this device below what the server records and
 * silently discard the account's next writes; a purge that raised the floor
 * without deleting would leave the residue the sweep exists to remove.
 *
 * Rows that carry no owner (pre-v5, or written while signed out) are left
 * alone: nothing identifies them as this account's, and deleting them on a
 * guess would drop another account's counter.
 */
export async function purgeDeviceSequencesForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const store = transaction.store;
  const owned = await store.getAll(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`));
  if (!owned.length) {
    await transaction.done;
    return;
  }
  const floorRow = await store.get(SEQUENCE_FLOOR_KEY);
  const floor = owned.reduce((highest, row) => Math.max(highest, row.value), floorRow?.value || 0);
  await store.put({ key: SEQUENCE_FLOOR_KEY, value: floor });
  await Promise.all(owned.map((row) => store.delete(row.key)));
  await transaction.done;
}

export async function listQueuedMutations(userId: string): Promise<QueuedMutation[]> {
  const db = await database();
  return db.getAllFromIndex("mutations", "by-user", userId);
}

/**
 * Every account with an unsent write in this database.
 *
 * The account purge enumerates the device before it sweeps it, and an account
 * whose only remaining trace is a queued mutation is still an account whose
 * intent — a rename, a tag, the title of a book — is readable by whoever signs
 * in next. Read from the `by-user` index's keys, so the cost is the number of
 * distinct accounts rather than the size of the queue.
 */
export async function listQueuedMutationUserIds(): Promise<string[]> {
  const db = await database();
  const index = db.transaction("mutations").store.index("by-user");
  const users: string[] = [];
  // A key cursor that skips past each account once it is seen: the walk costs
  // one step per distinct account, not one per queued write.
  let cursor = await index.openKeyCursor();
  while (cursor) {
    const userId = String(cursor.key);
    users.push(userId);
    cursor = await cursor.continue(`${userId}￿`);
  }
  return users;
}

/**
 * Drops one account's queue. `sequences` is deliberately untouched: those
 * high-water marks order every future replay, and resetting them would let a
 * stale event overwrite a newer one after the next sign-in.
 */
export async function clearQueuedMutationsForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  let cursor = await transaction.store.index("by-user").openCursor(userId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
}

// ---------------------------------------------------------------------------
// Failure classification (unchanged; every kind inherits it)
// ---------------------------------------------------------------------------

export function isRetryableMutationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function shouldRetainMutation(status: number): boolean {
  return status === 401 || status === 403 || isRetryableMutationStatus(status);
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export type ReplayRequest = { url: string; init: RequestInit };

/**
 * The wire form of a queued mutation. `mutationId` rides along on every kind
 * the server dedupes by receipt, and is identical on every retry — that is what
 * makes a replay of an already-applied mutation a no-op rather than a second
 * apply.
 */
export function toReplayRequest(mutation: QueuedMutation): ReplayRequest {
  const json = (method: string, body: Record<string, unknown>, url: string): ReplayRequest => ({
    url,
    init: { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  });
  switch (mutation.kind) {
    case "progress":
      return json(
        "PATCH",
        {
          deviceId: mutation.deviceId,
          deviceSequence: mutation.deviceSequence,
          ...mutation.payload,
        },
        `/api/books/${mutation.entityId}/progress`,
      );
    case "history":
      return json(
        "POST",
        { ...mutation.payload, id: mutation.mutationId },
        `/api/books/${mutation.entityId}/history`,
      );
    case "import":
      return json("POST", { ...mutation.payload }, "/api/books/local");
    case "collection":
      return json("PATCH", { ...mutation.payload }, `/api/collections/${mutation.entityId}`);
    case "delete":
      return {
        url: `/api/books/${mutation.entityId}`,
        init: { method: "DELETE", headers: { "X-Mutation-Id": mutation.mutationId } },
      };
    case "tag":
      // `{ tagId, include }` is NOT a shape `PATCH /api/books/:id` understands;
      // sending it flat made zod strip both keys, the handler apply nothing,
      // and the route answer 200 — which the outbox read as success and
      // deleted, reverting the edge on the next pull. It travels under
      // `tagEdge`, which the route's schema names explicitly, and carries the
      // `mutationId` so a replayed edge is a receipted no-op.
      return json(
        "PATCH",
        {
          tagEdge: {
            tagId: mutation.payload.tagId,
            include: mutation.payload.include,
            // Present whenever the device knew the name; lets the server
            // re-establish a vocabulary entry that was collected in between.
            ...(typeof mutation.payload.name === "string" ? { name: mutation.payload.name } : {}),
          },
          mutationId: mutation.mutationId,
        },
        `/api/books/${mutation.entityId}`,
      );
    default:
      return json("PATCH", { ...mutation.payload }, `/api/books/${mutation.entityId}`);
  }
}

export function replayQueuedMutations(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  return singleFlight(activeReplays, userId, () => replayQueueSnapshot(userId, fetchFn));
}

async function replayQueueSnapshot(userId: string, fetchFn: typeof fetch): Promise<void> {
  const db = await database();
  let afterKey: string | undefined;
  while (true) {
    const tasks = await readMutationPage(db, userId, afterKey);
    if (!tasks.length) return;
    await runBounded(tasks, REPLAY_CONCURRENCY, async (task) => {
      try {
        await replayMutation(task, fetchFn);
      } catch {
        // Network failures remain durable in IndexedDB.
      }
    });
    afterKey = tasks.at(-1)!.key;
    if (tasks.length < REPLAY_PAGE_SIZE) return;
  }
}

async function readMutationPage(db: SyncDb, userId: string, afterKey?: string) {
  const range = IDBKeyRange.bound([userId, afterKey || ""], [userId, "￿"], !!afterKey);
  const tasks: QueuedMutation[] = [];
  let cursor = await db.transaction("mutations").store.index("by-user-key").openCursor(range);
  while (cursor && tasks.length < REPLAY_PAGE_SIZE) {
    tasks.push(cursor.value);
    cursor = await cursor.continue();
  }
  return tasks;
}

function withMutationLock<T>(mutation: QueuedMutation, operation: () => Promise<T>): Promise<T> {
  // Progress shares its lock with the live writer in `use-progress-persistence`
  // so a replay and a heartbeat cannot interleave on one book.
  return mutation.kind === "progress"
    ? withProgressMutationLock(mutation.entityId, operation)
    : withKeyedLock(`chapterline:mutation:${mutation.key}`, operation);
}

/**
 * A queued progress row must not be the last word when this device already
 * knows a newer position for the same book.
 *
 * MEASURED, WebKit, hard kill: Postgres left holding 15245 ms against a true
 * position of 3231 ms. The 15 s server heartbeat queued the pre-rewind
 * position, the SIGKILL killed the write that would have followed the rewind,
 * and replay then delivered the queued value verbatim — carrying its ORIGINAL
 * `eventOccurredAt`, which the server's staleness policy compares against what
 * it holds rather than against what the device knows. The user was protected
 * only by `localWinsOver` on a ~1 s timestamp margin; a fresh install, a second
 * device or cleared storage makes the server authoritative and the user skips
 * ~12 seconds of a book they paid for.
 *
 * The outbox's own coalescing would have collapsed the two events into one had
 * the newer position ever been journalled. It was not — it only ever reached
 * the synchronous local write, which is the ONLY write a terminating iOS page
 * is guaranteed to complete, and is therefore the freshest thing this device
 * has. So the collapse is applied here instead, from that record, and the row
 * is rewritten in place: same intent ("where this user is in this book"), same
 * device, later moment. Nothing is invented — every field comes from a write
 * the app already made durable.
 *
 * A fresh `deviceSequence` is minted for the same reason `repointQueuedMutations`
 * mints one: the server discards a progress write whose sequence is not above
 * the last it recorded for (user, book, device), and answers 200 while doing
 * it, so re-using the stale row's number risks reporting success and vanishing.
 * It is minted at most once per row — the rewritten row's `eventOccurredAt` is
 * the local record's own, so the next pass finds nothing newer to fold in.
 */
async function supersedeStaleProgress(task: QueuedMutation): Promise<QueuedMutation> {
  if (task.kind !== "progress") return task;
  const queuedAt = Date.parse(String(task.payload.eventOccurredAt ?? ""));
  const local = readLocalProgress(task.userId, task.entityId);
  // `occurredAt: 0` is a pre-v2 record that claims no moment at all, so it
  // cannot claim a later one — the same rule `localWinsOver` applies.
  if (!local || !local.occurredAt || !Number.isFinite(queuedAt)) return task;
  if (local.occurredAt <= queuedAt) return task;
  if (Math.round(local.positionMs) === Number(task.payload.positionMs)) return task;

  // Raised past the row being replaced, not merely minted. `nextDeviceSequence`
  // counts what THIS device has issued, and a queued row can outrank that
  // counter — a v4→v5 migration that could not attribute its rows, or an
  // account purge that reset them, both leave the outbox holding a number the
  // counter no longer knows about. Handing the server a sequence at or below
  // the one it may already have recorded for this row is a write it answers 200
  // to and discards, which is the exact failure this whole function exists to
  // stop, arrived at from the other side.
  const deviceSequence = Math.max(
    await nextDeviceSequence(task.entityId, task.userId),
    task.deviceSequence + 1,
  );
  const superseded: QueuedMutation = {
    ...task,
    deviceSequence,
    payload: {
      ...task.payload,
      positionMs: Math.round(local.positionMs),
      ...(typeof local.playbackRate === "number" ? { playbackRate: local.playbackRate } : {}),
      ...(typeof local.completed === "boolean" ? { completed: local.completed } : {}),
      eventOccurredAt: new Date(local.occurredAt).toISOString(),
    },
  };

  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(task.key);
  // Replaced or settled while this was being assembled: that row is newer than
  // anything decided here, and `settleMutation` guards the same way.
  if (current?.mutationId !== task.mutationId) {
    await transaction.done;
    return current ?? task;
  }
  await transaction.store.put(superseded);
  await transaction.done;
  return superseded;
}

async function replayMutation(snapshot: QueuedMutation, fetchFn: typeof fetch): Promise<void> {
  await withMutationLock(snapshot, async () => {
    const task = await supersedeStaleProgress(snapshot);
    const { url, init } = toReplayRequest(task);
    const response = await fetchFn(url, init);
    if (shouldRetainMutation(response.status)) {
      await recordAttempt(task);
      return;
    }
    if (response.status === 404 && (await awaitsRegistration(task))) {
      // "That book does not exist" — YET. A book imported with no network is on
      // this device's screen before the server has heard of it, so the writes
      // the user makes against it are queued naming an id only this device
      // knows. The outbox replays in key order, and `archive`, `collection`,
      // `delete` and `history` all sort ahead of `import`, so they arrive
      // first, are told the book does not exist, and would be dropped as
      // terminal — the delete of a book the user really did delete among them.
      // The registration is still in this queue, and the book is one of the two
      // things it can produce: the id it names, or the canonical id a 409
      // re-points these rows onto. Either way this row is deliverable, and it
      // stays. Bounded by the registration's own life: once it leaves the queue
      // — settled, merged, or dropped as superseded — a 404 here is terminal
      // again on the very next drain.
      await recordAttempt(task);
      return;
    }
    if (response.status === 409) {
      if (task.kind === "progress") {
        await reconcileProgressConflict(toQueuedProgress(task), response);
      } else if (task.kind === "import" && !(await reattachDuplicateImport(task, response))) {
        // The merge is understood but could not be applied to this device yet.
        // Settling here would delete the only record of it, so the row stays
        // and the next drain asks again — the fingerprint is still taken, so
        // the answer, and the canonical id in it, are the same.
        await recordAttempt(task);
        return;
      }
    }
    await settleMutation(task);
  });
}

/**
 * The offline half of the re-import path (`docs/local-first.md` section 10).
 *
 * A queued registration carries the id this device minted, and the audio, the
 * download record and the transcript were written under it while the network
 * was down. 409 means the server matched the fingerprint to a book it already
 * has: the registration is settled — there is nothing left to send — but the
 * bytes on this device are filed under an id that now exists nowhere, and
 * dropping the answer here is what would leave the user with the same audiobook
 * twice. `local-import.ts` reaches the same outcome online by learning the
 * canonical id before storing anything; this reaches it afterwards, by moving
 * the identity rather than the data.
 *
 * True means "settle this row". A 409 that names no other book — a chapter
 * repair the server refused, or a registration that never carried an id —
 * settles too: those are terminal answers with nothing local to move.
 */
async function reattachDuplicateImport(task: QueuedMutation, response: Response): Promise<boolean> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { existingBookId?: unknown; playerBook?: unknown } | null;
  const canonicalId = typeof payload?.existingBookId === "string" ? payload.existingBookId : null;
  const importedId = typeof task.payload.bookId === "string" ? task.payload.bookId : null;
  if (!canonicalId || !importedId || canonicalId === importedId) return true;
  try {
    // The queue first, the bytes second. Both halves are idempotent and the
    // registration is only settled once both have run, so an interruption
    // between them is retried whole — but in the order that leaves the user's
    // queued edits addressed to a book that EXISTS if the process stops here.
    await repointQueuedMutations(task.userId, importedId, canonicalId);
    // Imported lazily: `offline/library.ts` imports this module for the account
    // purge, so a static edge here would close the cycle.
    const { reattachLocalBookIdentity } = await import("@/lib/offline/library");
    await reattachLocalBookIdentity(task.userId, importedId, canonicalId, payload?.playerBook);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Re-pointing a book id the server refused
// ---------------------------------------------------------------------------

/**
 * Is the book this row names still waiting to be registered by this device?
 *
 * True only while a registration naming that very id is in the queue, which is
 * what keeps the retention bounded: nothing here waits on a book the server
 * will never be told about.
 */
async function awaitsRegistration(task: QueuedMutation): Promise<boolean> {
  const bookId = queuedBookId(task);
  if (!bookId) return false;
  const db = await database();
  const queued = await db.getAllFromIndex("mutations", "by-user", task.userId);
  return queued.some((row) => row.kind === "import" && row.payload.bookId === bookId);
}

/**
 * Which book does this queued row act on?
 *
 * `collection` names the COLLECTION in `entityId` and the book in its payload.
 * `import` names a FINGERPRINT and no book at all — and it is the row whose own
 * answer triggers the move, so re-pointing it would be re-pointing the message
 * that carries the news.
 */
function queuedBookId(row: QueuedMutation): string | null {
  if (row.kind === "import") return null;
  if (row.kind === "collection") {
    return typeof row.payload.bookId === "string" ? row.payload.bookId : null;
  }
  return row.entityId;
}

/**
 * The same intent, addressed to another book.
 *
 * Every key comes from the production builder, called exactly as its own call
 * site in `offline/outbox.ts` calls it — including `tagMutationKey`, whose third
 * argument the tag path fills with the tag ID. A key assembled by hand here
 * would put two spellings of one intent in the outbox and coalesce neither.
 */
function addressedTo(row: QueuedMutation, bookId: string): QueuedMutation {
  switch (row.kind) {
    case "progress":
      return {
        ...row,
        entityId: bookId,
        key: progressMutationKey({ userId: row.userId, bookId, deviceId: row.deviceId }),
      };
    case "metadata":
      return { ...row, entityId: bookId, key: metadataMutationKey(row.userId, bookId) };
    case "archive":
      return { ...row, entityId: bookId, key: archiveMutationKey(row.userId, bookId) };
    case "tag":
      return {
        ...row,
        entityId: bookId,
        key: tagMutationKey(row.userId, bookId, String(row.payload.tagId ?? "")),
      };
    case "collection":
      return {
        ...row,
        payload: { ...row.payload, bookId },
        key: collectionMutationKey(row.userId, row.entityId, bookId),
      };
    case "delete":
    case "history":
      return {
        ...row,
        entityId: bookId,
        key: eventMutationKey(row.userId, row.kind, bookId, row.mutationId),
      };
    case "import":
      return row;
  }
}

/**
 * Re-addresses every queued row that still names the id a merge just abandoned.
 *
 * A book imported with no network is minted an id by this device, and the
 * library shows it — so the user can rename it, tag it, play it and delete it
 * long before the server has heard of it, and every one of those writes is
 * queued against that id. When the registration finally replays and the server
 * answers "those bytes are already book Y", the id they all name stops existing:
 * each row would replay into a 404, which is terminal, and be dropped as
 * settled. The user's rename is gone, their tag is gone, and their DELETE is
 * gone while the book quietly survives as Y.
 *
 * Two rows can become one intent here — a queued rename for the phantom and a
 * queued rename for Y are now the same edit. The later one wins, decided by
 * `queuedAt` and then handed to the shipping `resolveCoalescing`, rather than
 * one silently overwriting the other. `queuedAt` is the only ordering the pair
 * share: their device sequences were minted from two different books' counters.
 *
 * Progress is re-stamped with a sequence minted from the TARGET book's counter.
 * The server discards a progress write whose `deviceSequence` is not above what
 * it holds for (user, book, device) — and answers 200 while doing it — so a
 * sequence carried over from the phantom's counter is a write that reports
 * success and vanishes.
 *
 * Idempotent: a second run finds nothing naming the old id. That is what makes
 * it safe to do in a different database from the identity move it accompanies —
 * an interruption between the two halves leaves the registration queued, and
 * the next drain gets the same deterministic 409 and finishes the other half.
 */
export async function repointQueuedMutations(
  userId: string,
  fromBookId: string,
  toBookId: string,
): Promise<number> {
  if (!fromBookId || !toBookId || fromBookId === toBookId) return 0;
  const db = await database();
  const affected = (await db.getAllFromIndex("mutations", "by-user", userId)).filter(
    (row) => queuedBookId(row) === fromBookId,
  );
  if (!affected.length) return 0;
  // Minted before the transaction opens, because `nextDeviceSequence` owns the
  // `sequences` store and its own transaction. Burning a number costs nothing —
  // the server only requires the next one to be higher — while re-implementing
  // its floor arithmetic here would be exactly the hand-rolled duplicate the
  // rest of this module refuses.
  const sequence = affected.some((row) => row.kind === "progress")
    ? await nextDeviceSequence(toBookId, userId)
    : 0;

  const transaction = db.transaction("mutations", "readwrite");
  const store = transaction.store;
  let moved = 0;
  for (const snapshot of affected) {
    const current = await store.get(snapshot.key);
    // Settled or replaced while this was being read. `settleMutation` compares
    // the same id for the same reason: an acknowledgement of an older intent
    // must not carry a newer one along with it.
    if (!current || current.mutationId !== snapshot.mutationId) continue;
    const candidate = addressedTo(current, toBookId);
    // `never` kinds cannot collide: their key embeds a mutationId no other row
    // has. Everything else can, and is resolved rather than overwritten.
    const existing = await store.get(candidate.key);
    const winner = existing ? pickRepointWinner(existing, candidate) : candidate;
    await store.delete(current.key);
    await store.put(
      winner === candidate && winner.kind === "progress"
        ? { ...winner, key: candidate.key, deviceSequence: sequence }
        : { ...winner, key: candidate.key },
    );
    moved += 1;
  }
  await transaction.done;
  return moved;
}

function pickRepointWinner(existing: QueuedMutation, candidate: QueuedMutation): QueuedMutation {
  const candidateIsNewer = candidate.queuedAt > existing.queuedAt;
  // Highest-sequence-wins is meaningless across two books' counters, so for
  // progress the later intent is simply the one that stands — which is what
  // "sequence" coalescing means for two events from one device on one book.
  if (MUTATION_COALESCING[candidate.kind] === "sequence") {
    return candidateIsNewer ? candidate : existing;
  }
  return candidateIsNewer
    ? resolveCoalescing(existing, candidate)
    : resolveCoalescing(candidate, existing);
}

function toQueuedProgress(mutation: QueuedMutation): QueuedProgress {
  const payload = mutation.payload as unknown as Omit<
    QueuedProgress,
    "userId" | "bookId" | "deviceId" | "deviceSequence"
  >;
  return {
    userId: mutation.userId,
    bookId: mutation.entityId,
    deviceId: mutation.deviceId,
    deviceSequence: mutation.deviceSequence,
    ...payload,
  };
}

export async function reconcileProgressConflict(
  entry: QueuedProgress,
  response: Response,
): Promise<boolean> {
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { state?: Record<string, unknown> } | null;
  const state = payload?.state;
  const positionMs = state?.positionMs;
  const completed = state?.completed;
  const playbackRate = Number(state?.playbackRate);
  const eventOccurredAt = typeof state?.eventOccurredAt === "string" ? state.eventOccurredAt : null;
  if (
    typeof positionMs !== "number" ||
    typeof completed !== "boolean" ||
    !Number.isFinite(playbackRate)
  ) {
    return false;
  }
  if ((await currentDeviceSequence(entry.bookId)) > entry.deviceSequence) return false;
  const { projectOfflineProgress } = await import("@/lib/offline/library");
  const { saveLocalPosition } = await import("@/lib/playback-core");
  await projectOfflineProgress(entry.userId, entry.bookId, {
    positionMs,
    completed,
    playbackRate,
    eventOccurredAt,
  });
  saveLocalPosition(
    entry.userId,
    entry.bookId,
    positionMs,
    eventOccurredAt ? Date.parse(eventOccurredAt) : Date.now(),
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PROGRESS_CONFLICT_EVENT, {
        detail: { userId: entry.userId, bookId: entry.bookId, positionMs, completed, playbackRate },
      }),
    );
  }
  return true;
}

/**
 * Removes a settled row only if it is still the row that was sent. Coalescing
 * replaces the record in place while a replay is in flight, and the replacement
 * carries a new `mutationId`; comparing it is what stops the acknowledgement of
 * an older intent from erasing a newer, unsent one.
 */
async function settleMutation(snapshot: QueuedMutation): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(snapshot.key);
  if (current?.mutationId === snapshot.mutationId) await transaction.store.delete(snapshot.key);
  await transaction.done;
}

async function recordAttempt(snapshot: QueuedMutation): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(snapshot.key);
  if (current?.mutationId === snapshot.mutationId) {
    await transaction.store.put({ ...current, attempts: current.attempts + 1 });
  }
  await transaction.done;
}
