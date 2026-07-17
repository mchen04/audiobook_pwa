import { openDB, type DBSchema } from "idb";

import { PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
import { singleFlight } from "@/lib/single-flight";
import { withKeyedLock } from "@/lib/keyed-lock";
import { runBounded } from "@/lib/run-bounded";

const DATABASE_NAME = "chapterline-sync-v1";
export const REPLAY_PAGE_SIZE = 100;
export const REPLAY_CONCURRENCY = 4;
const activeReplays = new Map<string, Promise<void>>();

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

type ProgressMutation = {
  key: string;
  userId: string;
  kind: "progress";
  entry: QueuedProgress;
};

interface SyncDatabase extends DBSchema {
  mutations: {
    key: string;
    value: ProgressMutation;
    indexes: { "by-user": string; "by-user-key": [string, string] };
  };
  sequences: {
    key: string;
    value: { key: string; value: number };
  };
}

function database() {
  return openDB<SyncDatabase>(DATABASE_NAME, 3, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const mutations = db.createObjectStore("mutations", { keyPath: "key" });
        mutations.createIndex("by-user", "userId");
        mutations.createIndex("by-user-key", ["userId", "key"]);
        db.createObjectStore("sequences", { keyPath: "key" });
        return;
      }
      if (oldVersion < 2) {
        const mutations = transaction.objectStore("mutations");
        void mutations.openCursor().then(async function purgeLegacyMutation(cursor) {
          if (!cursor) return;
          const legacy = cursor.value as ProgressMutation | { kind: string };
          if (legacy.kind !== "progress") await cursor.delete();
          await purgeLegacyMutation(await cursor.continue());
        });
      }
      if (oldVersion < 3) {
        transaction.objectStore("mutations").createIndex("by-user-key", ["userId", "key"]);
      }
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
  if (!existing || existing.entry.deviceSequence <= entry.deviceSequence) {
    await transaction.store.put({ key, userId: entry.userId, kind: "progress", entry });
  }
  await transaction.done;
}

export function withProgressMutationLock<T>(
  bookId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(`chapterline:progress:${bookId}`, operation);
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
        await replayProgress(task, fetchFn);
      } catch {
        // Network failures remain durable in IndexedDB.
      }
    });
    afterKey = tasks.at(-1)!.key;
    if (tasks.length < REPLAY_PAGE_SIZE) return;
  }
}

async function readMutationPage(
  db: Awaited<ReturnType<typeof database>>,
  userId: string,
  afterKey?: string,
) {
  const range = IDBKeyRange.bound([userId, afterKey || ""], [userId, "\uffff"], !!afterKey);
  const tasks: ProgressMutation[] = [];
  let cursor = await db.transaction("mutations").store.index("by-user-key").openCursor(range);
  while (cursor && tasks.length < REPLAY_PAGE_SIZE) {
    tasks.push(cursor.value);
    cursor = await cursor.continue();
  }
  return tasks;
}

async function replayProgress(task: ProgressMutation, fetchFn: typeof fetch): Promise<void> {
  await withProgressMutationLock(task.entry.bookId, async () => {
    const response = await fetchFn(`/api/books/${task.entry.bookId}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: toProgressBody(task.entry),
    });
    if (shouldRetainMutation(response.status)) return;
    if (response.status === 409) await reconcileProgressConflict(task.entry, response);
    await removeProgressSnapshot(task);
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

async function removeProgressSnapshot(snapshot: ProgressMutation): Promise<void> {
  const db = await database();
  const transaction = db.transaction("mutations", "readwrite");
  const current = await transaction.store.get(snapshot.key);
  if (current?.entry.deviceSequence === snapshot.entry.deviceSequence) {
    await transaction.store.delete(snapshot.key);
  }
  await transaction.done;
}

function progressKey(entry: Pick<QueuedProgress, "userId" | "bookId" | "deviceId">) {
  return `${entry.userId}:progress:${entry.bookId}:${entry.deviceId}`;
}
