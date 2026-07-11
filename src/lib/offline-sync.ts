import { openDB, type DBSchema } from "idb";

import type { Bookmark } from "@/domain/player";
import { isBookmarkPayload } from "@/lib/wire";

const DATABASE_NAME = "chapterline-sync-v1";
const REPLAY_CONCURRENCY = 4;
const activeReplays = new Map<string, Promise<void>>();
const activeBookmarkLocks = new Map<string, Promise<void>>();
const activeProgressLocks = new Map<string, Promise<void>>();

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

export type QueuedBookmark = {
  userId: string;
  bookId: string;
  clientId: string;
  positionMs: number;
  note: string | null;
  createdAt: string;
  revision: number;
};

export type QueuedBookmarkUpdate = {
  userId: string;
  bookId: string;
  bookmarkId: string;
  note: string | null;
  previousNote?: string | null;
  revision: number;
};

export type QueuedBookmarkDelete = {
  userId: string;
  bookId: string;
  bookmarkId: string;
};

export type QueuedBookmarkClientDelete = {
  userId: string;
  bookId: string;
  clientId: string;
};

type StoredMutation =
  | { key: string; userId: string; kind: "progress"; entry: QueuedProgress }
  | { key: string; userId: string; kind: "bookmark"; entry: QueuedBookmark }
  | { key: string; userId: string; kind: "bookmark-update"; entry: QueuedBookmarkUpdate }
  | { key: string; userId: string; kind: "bookmark-delete"; entry: QueuedBookmarkDelete }
  | {
      key: string;
      userId: string;
      kind: "bookmark-client-delete";
      entry: QueuedBookmarkClientDelete;
    };

interface SyncDatabase extends DBSchema {
  mutations: {
    key: string;
    value: StoredMutation;
    indexes: { "by-user": string };
  };
  sequences: {
    key: string;
    value: { key: string; value: number };
  };
}

function database() {
  return openDB<SyncDatabase>(DATABASE_NAME, 1, {
    upgrade(db) {
      const mutations = db.createObjectStore("mutations", { keyPath: "key" });
      mutations.createIndex("by-user", "userId");
      db.createObjectStore("sequences", { keyPath: "key" });
    },
  });
}

export function toProgressBody(entry: Omit<QueuedProgress, "userId">): string {
  return JSON.stringify({
    deviceId: entry.deviceId,
    deviceSequence: entry.deviceSequence,
    positionMs: Math.round(entry.positionMs),
    playbackRate: entry.playbackRate,
    completed: entry.completed,
    eventOccurredAt: entry.eventOccurredAt,
  });
}

export async function queueProgress(entry: QueuedProgress): Promise<void> {
  const db = await database();
  const key = progressKey(entry);
  const transaction = db.transaction("mutations", "readwrite");
  const existing = await transaction.store.get(key);
  if (existing?.kind !== "progress" || existing.entry.deviceSequence <= entry.deviceSequence) {
    await transaction.store.put({ key, userId: entry.userId, kind: "progress", entry });
  }
  await transaction.done;
}

export async function queueBookmark(entry: QueuedBookmark): Promise<void> {
  const db = await database();
  await db.put("mutations", {
    key: bookmarkKey(entry),
    userId: entry.userId,
    kind: "bookmark",
    entry,
  });
}

export async function queuedBookmarksFor(
  userId: string,
  bookId: string,
): Promise<QueuedBookmark[]> {
  const db = await database();
  const entries = await db.getAllFromIndex("mutations", "by-user", userId);
  return entries
    .filter(
      (stored): stored is Extract<StoredMutation, { kind: "bookmark" }> =>
        stored.kind === "bookmark" && stored.entry.bookId === bookId,
    )
    .map((stored) => stored.entry);
}

export async function updateQueuedBookmarkNote(
  userId: string,
  clientId: string,
  note: string | null,
): Promise<boolean> {
  const db = await database();
  const key = bookmarkKey({ userId, clientId });
  const transaction = db.transaction("mutations", "readwrite");
  const stored = await transaction.store.get(key);
  const updated = stored?.kind === "bookmark";
  if (updated) {
    await transaction.store.put({
      ...stored,
      entry: { ...stored.entry, note, revision: stored.entry.revision + 1 },
    });
  }
  await transaction.done;
  return updated;
}

export async function removeQueuedBookmark(userId: string, clientId: string): Promise<void> {
  const db = await database();
  await db.delete("mutations", bookmarkKey({ userId, clientId }));
}

export async function removeQueuedBookmarkSnapshot(entry: QueuedBookmark): Promise<void> {
  const db = await database();
  const key = bookmarkKey(entry);
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(key);
  if (current?.kind === "bookmark" && current.entry.revision === entry.revision) {
    await transaction.store.delete(key);
  }
  await transaction.done;
}

export async function queueBookmarkUpdate(
  entry: Omit<QueuedBookmarkUpdate, "revision">,
): Promise<QueuedBookmarkUpdate> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const deleteKey = bookmarkDeleteKey(entry);
  const pendingDelete = await transaction.store.get(deleteKey);
  if (pendingDelete) {
    await transaction.done;
    return { ...entry, revision: 0 };
  }
  const key = bookmarkUpdateKey(entry);
  const current = await transaction.store.get(key);
  const revision = current?.kind === "bookmark-update" ? current.entry.revision + 1 : 1;
  const queued = { ...entry, revision };
  await transaction.store.put({
    key,
    userId: entry.userId,
    kind: "bookmark-update",
    entry: queued,
  });
  await transaction.done;
  return queued;
}

export async function queueBookmarkDelete(
  entry: QueuedBookmarkDelete,
): Promise<QueuedBookmarkDelete> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  await transaction.store.delete(bookmarkUpdateKey(entry));
  await transaction.store.put({
    key: bookmarkDeleteKey(entry),
    userId: entry.userId,
    kind: "bookmark-delete",
    entry,
  });
  await transaction.done;
  return entry;
}

export async function completeBookmarkUpdate(entry: QueuedBookmarkUpdate): Promise<boolean> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const [current, pendingDelete] = await Promise.all([
    transaction.store.get(bookmarkUpdateKey(entry)),
    transaction.store.get(bookmarkDeleteKey(entry)),
  ]);
  const isCurrent =
    current?.kind === "bookmark-update" && current.entry.revision === entry.revision;
  if (isCurrent) await transaction.store.delete(bookmarkUpdateKey(entry));
  await transaction.done;
  return isCurrent && pendingDelete?.kind !== "bookmark-delete";
}

export async function isCurrentBookmarkUpdate(entry: QueuedBookmarkUpdate): Promise<boolean> {
  const db = await database();
  const current = await db.get("mutations", bookmarkUpdateKey(entry));
  return current?.kind === "bookmark-update" && current.entry.revision === entry.revision;
}

export async function withBookmarkMutationLock<T>(
  userId: string,
  bookId: string,
  bookmarkId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${userId}:${bookId}:${bookmarkId}`;
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`chapterline:bookmark:${key}`, operation);
  }
  const previous = activeBookmarkLocks.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  activeBookmarkLocks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeBookmarkLocks.get(key) === queued) activeBookmarkLocks.delete(key);
  }
}

export async function withProgressMutationLock<T>(
  bookId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`chapterline:progress:${bookId}`, operation);
  }
  const previous = activeProgressLocks.get(bookId) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  activeProgressLocks.set(bookId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeProgressLocks.get(bookId) === queued) activeProgressLocks.delete(bookId);
  }
}

export async function completeBookmarkDelete(entry: QueuedBookmarkDelete): Promise<void> {
  await removeSnapshot({
    key: bookmarkDeleteKey(entry),
    userId: entry.userId,
    kind: "bookmark-delete",
    entry,
  });
}

export async function completeBookmarkClientDeleteIfPresent(
  entry: QueuedBookmark,
  fetchFn: typeof fetch = fetch,
  removeIfMissing = false,
): Promise<boolean> {
  const pendingDelete = await queuedClientDelete(entry);
  if (!pendingDelete) return false;
  const response = await fetchFn(
    `/api/books/${entry.bookId}/bookmarks?clientId=${encodeURIComponent(entry.clientId)}`,
    { method: "DELETE" },
  );
  if (shouldRetainMutation(response.status)) return true;
  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as { bookmarkId?: unknown } | null;
  const deletedId = typeof payload?.bookmarkId === "string" ? payload.bookmarkId : null;
  if (deletedId) {
    const { projectOfflineBookmark } = await import("@/lib/offline-library");
    await projectOfflineBookmark(entry.userId, entry.bookId, {
      kind: "delete",
      bookmarkId: deletedId,
    });
    broadcastBookmarkReconciliation(entry, { kind: "delete", bookmarkId: deletedId });
  }
  if (deletedId || response.status === 204 || removeIfMissing) await removeSnapshot(pendingDelete);
  return true;
}

export async function queueBookmarkClientDelete(entry: QueuedBookmarkClientDelete): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  await transaction.store.delete(bookmarkKey(entry));
  await transaction.store.put({
    key: bookmarkClientDeleteKey(entry),
    userId: entry.userId,
    kind: "bookmark-client-delete",
    entry,
  });
  await transaction.done;
}

export async function nextDeviceSequence(bookId: string): Promise<number> {
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const current = await transaction.store.get(bookId);
  const next = (current?.value || 0) + 1;
  await transaction.store.put({ key: bookId, value: next });
  await transaction.done;
  return next;
}

export async function currentDeviceSequence(bookId: string): Promise<number> {
  const db = await database();
  return (await db.get("sequences", bookId))?.value || 0;
}

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

export function isRetryableMutationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function shouldRetainMutation(status: number): boolean {
  return status === 401 || status === 403 || isRetryableMutationStatus(status);
}

export function replayQueuedMutations(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const active = activeReplays.get(userId);
  if (active) return active;
  const replay = replayQueueSnapshot(userId, fetchFn).finally(() => {
    if (activeReplays.get(userId) === replay) activeReplays.delete(userId);
  });
  activeReplays.set(userId, replay);
  return replay;
}

async function replayQueueSnapshot(userId: string, fetchFn: typeof fetch): Promise<void> {
  const db = await database();
  const tasks = await db.getAllFromIndex("mutations", "by-user", userId);
  await runBounded(tasks, async (task) => {
    try {
      if (task.kind === "progress") {
        await replayProgress(task, fetchFn);
        return;
      }
      if (task.kind === "bookmark-update") {
        await replayBookmarkUpdate(task, fetchFn);
        return;
      }
      let response: Response;
      if (task.kind === "bookmark") {
        response = await fetchFn(`/api/books/${task.entry.bookId}/bookmarks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: task.entry.clientId,
            positionMs: task.entry.positionMs,
            note: task.entry.note,
          }),
        });
      } else if (task.kind === "bookmark-delete") {
        response = await fetchFn(
          `/api/books/${task.entry.bookId}/bookmarks/${task.entry.bookmarkId}`,
          { method: "DELETE" },
        );
      } else {
        response = await fetchFn(
          `/api/books/${task.entry.bookId}/bookmarks?clientId=${encodeURIComponent(task.entry.clientId)}`,
          { method: "DELETE" },
        );
      }
      if (!shouldRetainMutation(response.status)) {
        await reconcileBookmarkMutation(task, response, fetchFn);
        await removeSnapshot(task);
      }
    } catch {
      // Network failures remain durable in IndexedDB.
    }
  });
}

async function replayProgress(
  task: Extract<StoredMutation, { kind: "progress" }>,
  fetchFn: typeof fetch,
): Promise<void> {
  await withProgressMutationLock(task.entry.bookId, async () => {
    const response = await fetchFn(`/api/books/${task.entry.bookId}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: toProgressBody(task.entry),
    });
    if (shouldRetainMutation(response.status)) return;
    if (response.status === 409) await reconcileProgressConflict(task.entry, response);
    await removeSnapshot(task);
  });
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
  const { projectOfflineProgress } = await import("@/lib/offline-library");
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
      new CustomEvent("chapterline:progress-conflict", {
        detail: { userId: entry.userId, bookId: entry.bookId, positionMs, completed, playbackRate },
      }),
    );
  }
  return true;
}

async function replayBookmarkUpdate(
  task: Extract<StoredMutation, { kind: "bookmark-update" }>,
  fetchFn: typeof fetch,
): Promise<void> {
  await withBookmarkMutationLock(
    task.entry.userId,
    task.entry.bookId,
    task.entry.bookmarkId,
    async () => {
      if (!(await isCurrentBookmarkUpdate(task.entry))) return;
      const response = await fetchFn(
        `/api/books/${task.entry.bookId}/bookmarks/${task.entry.bookmarkId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: task.entry.note }),
        },
      );
      if (shouldRetainMutation(response.status)) return;
      const payload = await response
        .clone()
        .json()
        .catch(() => null);
      const { projectOfflineBookmark } = await import("@/lib/offline-library");
      if (response.ok && isBookmarkPayload(payload)) {
        await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
          kind: "upsert",
          bookmark: payload.bookmark,
        });
        broadcastBookmarkReconciliation(task.entry, {
          kind: "upsert",
          bookmark: payload.bookmark,
        });
      } else if (response.status === 404) {
        await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
          kind: "delete",
          bookmarkId: task.entry.bookmarkId,
        });
        broadcastBookmarkReconciliation(task.entry, {
          kind: "delete",
          bookmarkId: task.entry.bookmarkId,
        });
      } else if (task.entry.previousNote !== undefined) {
        await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
          kind: "note",
          bookmarkId: task.entry.bookmarkId,
          note: task.entry.previousNote,
        });
        broadcastBookmarkReconciliation(task.entry, {
          kind: "note",
          bookmarkId: task.entry.bookmarkId,
          note: task.entry.previousNote,
        });
      }
      await removeSnapshot(task);
    },
  );
}

async function reconcileBookmarkMutation(
  task: StoredMutation,
  response: Response,
  fetchFn: typeof fetch,
): Promise<void> {
  if (task.kind === "progress") return;
  const { projectOfflineBookmark } = await import("@/lib/offline-library");
  if (task.kind === "bookmark") {
    const pendingBookmarkId = `pending:${task.entry.clientId}`;
    await withBookmarkMutationLock(
      task.entry.userId,
      task.entry.bookId,
      pendingBookmarkId,
      async () => {
        const payload = await response
          .clone()
          .json()
          .catch(() => null);
        await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
          kind: "delete",
          bookmarkId: pendingBookmarkId,
        });
        if (!response.ok || !isBookmarkPayload(payload)) {
          await completeBookmarkClientDeleteIfPresent(task.entry, fetchFn, true);
          dispatchBookmarkRejected(task.entry, pendingBookmarkId);
          return;
        }
        if (await completeBookmarkClientDeleteIfPresent(task.entry, fetchFn, true)) {
          dispatchBookmarkRejected(task.entry, pendingBookmarkId);
          return;
        }
        await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
          kind: "upsert",
          bookmark: payload.bookmark,
        });
        broadcastBookmarkReconciliation(task.entry, {
          kind: "upsert",
          bookmark: payload.bookmark,
          pendingId: pendingBookmarkId,
        });
      },
    );
    return;
  }
  if (task.kind === "bookmark-update") return;
  await projectOfflineBookmark(task.entry.userId, task.entry.bookId, {
    kind: "delete",
    bookmarkId:
      task.kind === "bookmark-delete" ? task.entry.bookmarkId : `pending:${task.entry.clientId}`,
  });
  broadcastBookmarkReconciliation(task.entry, {
    kind: "delete",
    bookmarkId:
      task.kind === "bookmark-delete" ? task.entry.bookmarkId : `pending:${task.entry.clientId}`,
  });
}

async function queuedClientDelete(
  entry: QueuedBookmark,
): Promise<Extract<StoredMutation, { kind: "bookmark-client-delete" }> | null> {
  const db = await database();
  const stored = await db.get("mutations", bookmarkClientDeleteKey(entry));
  return stored?.kind === "bookmark-client-delete" ? stored : null;
}

function dispatchBookmarkRejected(
  entry: Pick<QueuedBookmark, "userId" | "bookId">,
  bookmarkId: string,
): void {
  if (typeof window === "undefined") return;
  broadcastBookmarkReconciliation(entry, { kind: "delete", bookmarkId });
  window.dispatchEvent(
    new CustomEvent("chapterline:bookmark-rejected", {
      detail: { userId: entry.userId, bookId: entry.bookId, bookmarkId },
    }),
  );
}

export function broadcastBookmarkReconciliation(
  entry: { userId: string; bookId: string },
  mutation:
    | { kind: "delete"; bookmarkId: string }
    | { kind: "note"; bookmarkId: string; note: string | null }
    | { kind: "upsert"; bookmark: Bookmark; pendingId?: string },
): void {
  if (typeof window === "undefined") return;
  const detail = { ...entry, ...mutation };
  window.dispatchEvent(new CustomEvent("chapterline:bookmark-reconciled", { detail }));
  try {
    const key = "chapterline:bookmark-reconciled";
    localStorage.setItem(key, JSON.stringify({ ...detail, nonce: crypto.randomUUID() }));
    localStorage.removeItem(key);
  } catch {
    // Cross-tab publication is best-effort and must never affect mutation durability.
  }
}

async function removeSnapshot(snapshot: StoredMutation): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(snapshot.key);
  const unchanged =
    current?.kind === "progress" && snapshot.kind === "progress"
      ? current.entry.deviceSequence === snapshot.entry.deviceSequence
      : current?.kind === "bookmark" && snapshot.kind === "bookmark"
        ? current.entry.revision === snapshot.entry.revision
        : current?.kind === "bookmark-update" && snapshot.kind === "bookmark-update"
          ? current.entry.revision === snapshot.entry.revision
          : current?.kind === "bookmark-delete" && snapshot.kind === "bookmark-delete"
            ? true
            : current?.kind === "bookmark-client-delete" &&
              snapshot.kind === "bookmark-client-delete";
  if (unchanged) await transaction.store.delete(snapshot.key);
  await transaction.done;
}

async function runBounded<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const item = items[next++];
      if (item) await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, items.length) }, run));
}

function progressKey(entry: Pick<QueuedProgress, "userId" | "bookId" | "deviceId">) {
  return `${entry.userId}:progress:${entry.bookId}:${entry.deviceId}`;
}

function bookmarkKey(entry: Pick<QueuedBookmark, "userId" | "clientId">) {
  return `${entry.userId}:bookmark:${entry.clientId}`;
}

function bookmarkUpdateKey(entry: Pick<QueuedBookmarkUpdate, "userId" | "bookmarkId">) {
  return `${entry.userId}:bookmark-update:${entry.bookmarkId}`;
}

function bookmarkDeleteKey(entry: Pick<QueuedBookmarkDelete, "userId" | "bookmarkId">) {
  return `${entry.userId}:bookmark-delete:${entry.bookmarkId}`;
}

function bookmarkClientDeleteKey(entry: Pick<QueuedBookmarkClientDelete, "userId" | "clientId">) {
  return `${entry.userId}:bookmark-client-delete:${entry.clientId}`;
}
