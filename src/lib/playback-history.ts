import { openDB, type DBSchema, type IDBPDatabase, type IDBPObjectStore } from "idb";

import type { PlaybackHistoryEntry, PlaybackHistorySnapshot } from "@/domain/player";
import { PLAYBACK_HISTORY_LIMIT } from "@/domain/playback-history";
import { shouldRetainMutation } from "@/lib/offline-sync";
import { runBounded } from "@/lib/run-bounded";

export { PLAYBACK_HISTORY_LIMIT } from "@/domain/playback-history";
const DATABASE_NAME = "hark-playback-history-v1";
const REPLAY_PAGE_SIZE = 100;
const REPLAY_CONCURRENCY = 4;
const activeHistoryReplays = new Map<string, Promise<void>>();
const activeBookSyncLocks = new Map<string, Promise<void>>();

export type PlaybackActionStoreResult = "stored" | "rejected" | "unavailable";

type StoredPlaybackAction = PlaybackHistoryEntry & {
  userId: string;
  bookId: string;
  localOrder: number;
  syncState: "pending" | "synced";
};

type LocalSequence = { key: string; value: number };

interface PlaybackHistoryDatabase extends DBSchema {
  actions: {
    key: string;
    value: StoredPlaybackAction;
    indexes: {
      "by-book-order": [string, string, number];
      "by-user-sync": [string, string, string, number];
      "by-user": string;
    };
  };
  sequences: {
    key: string;
    value: LocalSequence;
  };
}

function database() {
  return openDB<PlaybackHistoryDatabase>(DATABASE_NAME, 4, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const actions = db.createObjectStore("actions", { keyPath: "id" });
        actions.createIndex("by-book-order", ["userId", "bookId", "localOrder"]);
        actions.createIndex("by-user-sync", ["userId", "syncState", "bookId", "localOrder"]);
        actions.createIndex("by-user", "userId");
        db.createObjectStore("sequences", { keyPath: "key" });
        return;
      }
      if (oldVersion < 2) {
        const actions = transaction.objectStore("actions");
        actions.deleteIndex("by-book-time");
        actions.createIndex("by-book-order", ["userId", "bookId", "localOrder"]);
        const sequences = db.createObjectStore("sequences", { keyPath: "key" });
        void actions.getAll().then(async (legacyEntries) => {
          const counters = new Map<string, number>();
          legacyEntries.sort((left, right) =>
            left.occurredAt === right.occurredAt
              ? left.id.localeCompare(right.id)
              : left.occurredAt.localeCompare(right.occurredAt),
          );
          for (const legacy of legacyEntries) {
            const key = sequenceKey(legacy.userId, legacy.bookId);
            const localOrder = (counters.get(key) || 0) + 1;
            counters.set(key, localOrder);
            await actions.put({
              ...legacy,
              recordedAt: legacy.recordedAt || legacy.occurredAt,
              localOrder,
            });
          }
          for (const [key, value] of counters) await sequences.put({ key, value });
        });
      }
      if (oldVersion < 3) {
        const actions = transaction.objectStore("actions");
        actions.deleteIndex("by-user-sync");
        actions.createIndex("by-user-sync", ["userId", "syncState", "id"]);
      }
      if (oldVersion < 4) {
        const actions = transaction.objectStore("actions");
        actions.deleteIndex("by-user-sync");
        actions.createIndex("by-user-sync", ["userId", "syncState", "bookId", "localOrder"]);
      }
    },
  });
}

export async function loadPlaybackHistory(
  userId: string,
  bookId: string,
  serverSnapshot?: PlaybackHistorySnapshot,
): Promise<PlaybackHistoryEntry[]> {
  const db = await database();
  if (serverSnapshot) {
    const transaction = db.transaction(["actions", "sequences"], "readwrite");
    const actions = transaction.objectStore("actions");
    const existing = await actions.index("by-book-order").getAll(bookRange(userId, bookId));
    const accepted = [...serverSnapshot.entries].reverse().map((entry) => {
      return {
        ...entry,
        userId,
        bookId,
        localOrder: 0,
        syncState: "synced" as const,
      };
    });
    const acceptedIds = new Set(serverSnapshot.entries.map((entry) => entry.id));
    const capturedAt = Date.parse(serverSnapshot.capturedAt);
    const localAfterSnapshot = existing.filter(
      (entry) =>
        !acceptedIds.has(entry.id) &&
        (entry.syncState === "pending" ||
          (Number.isFinite(capturedAt) && Date.parse(entry.recordedAt) >= capturedAt)),
    );
    const ordered = [...accepted, ...localAfterSnapshot];
    let existingCursor = await actions.index("by-book-order").openCursor(bookRange(userId, bookId));
    while (existingCursor) {
      await existingCursor.delete();
      existingCursor = await existingCursor.continue();
    }
    for (const [index, entry] of ordered.entries()) {
      await actions.put({
        ...entry,
        localOrder: index + 1,
      });
    }
    await transaction.objectStore("sequences").put({
      key: sequenceKey(userId, bookId),
      value: ordered.length,
    });
    await transaction.done;
    await trimBookHistory(db, userId, bookId);
  }
  return readBookHistory(db, userId, bookId);
}

export async function storePlaybackAction(
  userId: string,
  bookId: string,
  entry: PlaybackHistoryEntry,
  fetchFn: typeof fetch = fetch,
): Promise<PlaybackActionStoreResult> {
  try {
    const db = await database();
    const transaction = db.transaction(["actions", "sequences"], "readwrite");
    const sequences = transaction.objectStore("sequences");
    const localOrder = (await currentLocalOrder(sequences, userId, bookId)) + 1;
    const stored = { ...entry, userId, bookId, localOrder, syncState: "pending" as const };
    await transaction.objectStore("actions").put(stored);
    await sequences.put({ key: sequenceKey(userId, bookId), value: localOrder });
    await transaction.done;
    await trimBookHistory(db, userId, bookId);
    return (await syncPlaybackActionInOrder(stored, fetchFn)) ? "stored" : "rejected";
  } catch {
    return "unavailable";
  }
}

export async function replayPlaybackHistory(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const active = activeHistoryReplays.get(userId);
  if (active) return active;
  const replay = replayPlaybackHistorySnapshot(userId, fetchFn).finally(() => {
    if (activeHistoryReplays.get(userId) === replay) activeHistoryReplays.delete(userId);
  });
  activeHistoryReplays.set(userId, replay);
  return replay;
}

async function replayPlaybackHistorySnapshot(userId: string, fetchFn: typeof fetch): Promise<void> {
  const db = await database();
  let afterId: { bookId: string; localOrder: number } | undefined;
  while (true) {
    const page = await readPendingPage(db, userId, afterId);
    if (!page.length) return;
    const byBook = new Map<string, StoredPlaybackAction[]>();
    for (const entry of page) {
      const entries = byBook.get(entry.bookId) || [];
      entries.push(entry);
      byBook.set(entry.bookId, entries);
    }
    await runBounded([...byBook.values()], REPLAY_CONCURRENCY, async (entries) => {
      for (const entry of entries) await syncPlaybackActionInOrder(entry, fetchFn);
    });
    const last = page.at(-1)!;
    afterId = { bookId: last.bookId, localOrder: last.localOrder };
    if (page.length < REPLAY_PAGE_SIZE) return;
  }
}

export async function clearPlaybackHistoryForBook(userId: string, bookId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["actions", "sequences"], "readwrite");
  let cursor = await transaction
    .objectStore("actions")
    .index("by-book-order")
    .openCursor(bookRange(userId, bookId));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.objectStore("sequences").delete(sequenceKey(userId, bookId));
  await transaction.done;
}

export async function clearPlaybackHistoryForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(["actions", "sequences"], "readwrite");
  let actionCursor = await transaction.objectStore("actions").index("by-user").openCursor(userId);
  while (actionCursor) {
    await actionCursor.delete();
    actionCursor = await actionCursor.continue();
  }
  let sequenceCursor = await transaction.objectStore("sequences").openCursor();
  while (sequenceCursor) {
    if (String(sequenceCursor.key).startsWith(`${userId}:`)) await sequenceCursor.delete();
    sequenceCursor = await sequenceCursor.continue();
  }
  await transaction.done;
}

async function syncPlaybackAction(
  entry: StoredPlaybackAction,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`/api/books/${entry.bookId}/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: entry.id,
        action: entry.action,
        positionMs: entry.positionMs,
        previousPositionMs: entry.previousPositionMs,
        playbackRate: entry.playbackRate,
        description: entry.description,
        occurredAt: entry.occurredAt,
      }),
    });
    if (shouldRetainMutation(response.status)) return true;
    const payload = response.ok
      ? ((await response
          .clone()
          .json()
          .catch(() => null)) as { recordedAt?: unknown } | null)
      : null;
    const db = await database();
    const transaction = db.transaction("actions", "readwrite");
    const current = await transaction.store.get(entry.id);
    if (response.ok && current?.syncState === "pending") {
      const recordedAt =
        typeof payload?.recordedAt === "string" ? payload.recordedAt : current.recordedAt;
      await transaction.store.put({ ...current, recordedAt, syncState: "synced" });
      await transaction.done;
      return true;
    }
    if (current?.syncState === "pending") await transaction.store.delete(entry.id);
    await transaction.done;
    return false;
  } catch {
    // IndexedDB remains the durable offline queue.
    return true;
  }
}

async function syncPlaybackActionInOrder(
  entry: StoredPlaybackAction,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const key = sequenceKey(entry.userId, entry.bookId);
  const operation = () => withModuleHistorySyncLock(key, () => drainPendingBook(entry, fetchFn));
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`hark:playback-history:${key}`, operation);
  }
  return operation();
}

async function withModuleHistorySyncLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeBookSyncLocks.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  activeBookSyncLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeBookSyncLocks.get(key) === queued) activeBookSyncLocks.delete(key);
  }
}

async function drainPendingBook(
  target: StoredPlaybackAction,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const db = await database();
  const entries = await db
    .transaction("actions")
    .store.index("by-book-order")
    .getAll(bookRange(target.userId, target.bookId));
  let targetResult: boolean | undefined;
  for (const entry of entries) {
    if (entry.syncState !== "pending") continue;
    const accepted = await syncPlaybackAction(entry, fetchFn);
    if (entry.id === target.id) targetResult = accepted;
    if ((await db.get("actions", entry.id))?.syncState === "pending") break;
  }
  if (targetResult !== undefined) return targetResult;
  return Boolean(await db.get("actions", target.id));
}

async function readPendingPage(
  db: IDBPDatabase<PlaybackHistoryDatabase>,
  userId: string,
  afterId?: { bookId: string; localOrder: number },
): Promise<StoredPlaybackAction[]> {
  const pending: StoredPlaybackAction[] = [];
  const range = IDBKeyRange.bound(
    [userId, "pending", afterId?.bookId || "", afterId?.localOrder || 0],
    [userId, "pending", "\uffff", Number.MAX_SAFE_INTEGER],
    !!afterId,
  );
  let cursor = await db.transaction("actions").store.index("by-user-sync").openCursor(range);
  while (cursor && pending.length < REPLAY_PAGE_SIZE) {
    pending.push(cursor.value);
    cursor = await cursor.continue();
  }
  return pending;
}

async function readBookHistory(
  db: IDBPDatabase<PlaybackHistoryDatabase>,
  userId: string,
  bookId: string,
): Promise<PlaybackHistoryEntry[]> {
  const entries: PlaybackHistoryEntry[] = [];
  let cursor = await db
    .transaction("actions")
    .store.index("by-book-order")
    .openCursor(bookRange(userId, bookId), "prev");
  while (cursor && entries.length < PLAYBACK_HISTORY_LIMIT) {
    entries.push(toHistoryEntry(cursor.value));
    cursor = await cursor.continue();
  }
  return entries;
}

async function trimBookHistory(
  db: IDBPDatabase<PlaybackHistoryDatabase>,
  userId: string,
  bookId: string,
): Promise<void> {
  const transaction = db.transaction("actions", "readwrite");
  let cursor = await transaction.store
    .index("by-book-order")
    .openCursor(bookRange(userId, bookId), "prev");
  let seen = 0;
  while (cursor) {
    seen += 1;
    if (seen > PLAYBACK_HISTORY_LIMIT) await cursor.delete();
    cursor = await cursor.continue();
  }
  await transaction.done;
}

async function currentLocalOrder(
  store: IDBPObjectStore<
    PlaybackHistoryDatabase,
    ("actions" | "sequences")[],
    "sequences",
    "readwrite"
  >,
  userId: string,
  bookId: string,
): Promise<number> {
  return (await store.get(sequenceKey(userId, bookId)))?.value || 0;
}

function bookRange(userId: string, bookId: string) {
  return IDBKeyRange.bound([userId, bookId, 0], [userId, bookId, Number.MAX_SAFE_INTEGER]);
}

function sequenceKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}

function toHistoryEntry(entry: StoredPlaybackAction): PlaybackHistoryEntry {
  return {
    id: entry.id,
    action: entry.action,
    positionMs: entry.positionMs,
    previousPositionMs: entry.previousPositionMs,
    playbackRate: entry.playbackRate,
    description: entry.description,
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt,
  };
}
