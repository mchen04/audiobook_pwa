import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";

import { ACTIVE_USER_KEY, PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
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
  await transaction.done;
  return winner;
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

export async function queueProgress(entry: QueuedProgress): Promise<void> {
  await queueMutation(
    buildMutation({
      key: progressMutationKey(entry),
      userId: entry.userId,
      kind: "progress",
      entityId: entry.bookId,
      payload: progressPayload(entry),
      deviceId: entry.deviceId,
      deviceSequence: entry.deviceSequence,
    }),
  );
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

async function replayMutation(task: QueuedMutation, fetchFn: typeof fetch): Promise<void> {
  await withMutationLock(task, async () => {
    const { url, init } = toReplayRequest(task);
    const response = await fetchFn(url, init);
    if (shouldRetainMutation(response.status)) {
      await recordAttempt(task);
      return;
    }
    if (response.status === 409 && task.kind === "progress") {
      await reconcileProgressConflict(toQueuedProgress(task), response);
    }
    await settleMutation(task);
  });
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
