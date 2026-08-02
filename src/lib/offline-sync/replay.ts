import { readLocalProgress } from "@/lib/playback-core";
import { singleFlight } from "@/lib/single-flight";
import { withKeyedLock } from "@/lib/keyed-lock";
import { runBounded } from "@/lib/run-bounded";

import { database, type QueuedMutation, type SyncDb } from "./db";
import { withProgressMutationLock } from "./queue";
import {
  awaitsRegistration,
  reattachDuplicateImport,
  reconcileProgressConflict,
  toQueuedProgress,
} from "./reconcile";
import { nextDeviceSequence } from "./sequences";

export const REPLAY_PAGE_SIZE = 100;
export const REPLAY_CONCURRENCY = 4;
const activeReplays = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Failure classification (unchanged; every kind inherits it)
// ---------------------------------------------------------------------------

function isRetryableMutationStatus(status: number): boolean {
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
        if (!(await reconcileProgressConflict(toQueuedProgress(task), response))) {
          // No subscriber yet: the server's answer cannot be projected onto
          // local state, and settling would delete the only record of the
          // conflict. The row stays and the next drain reconciles it.
          await recordAttempt(task);
          return;
        }
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
