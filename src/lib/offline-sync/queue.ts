import type { IDBPTransaction } from "idb";

import { withKeyedLock } from "@/lib/keyed-lock";

import {
  database,
  progressPayload,
  type MutationKind,
  type QueuedMutation,
  type QueuedProgress,
  type SyncDatabase,
} from "./db";
import { progressMutationKey } from "./keys";

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

export function newMutationId(): string {
  return crypto.randomUUID();
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

export function resolveCoalescing(
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
