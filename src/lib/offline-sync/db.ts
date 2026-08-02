import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

const DATABASE_NAME = "chapterline-sync-v1";
const SYNC_DATABASE_VERSION = 5;

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

export interface SyncDatabase extends DBSchema {
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

export type SyncDb = IDBPDatabase<SyncDatabase>;

export function database() {
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
function migrateLegacyMutation(row: LegacyProgressMutation | QueuedMutation): QueuedMutation {
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

export function progressPayload(entry: Omit<QueuedProgress, "userId">): Record<string, unknown> {
  return {
    positionMs: Math.round(entry.positionMs),
    playbackRate: entry.playbackRate,
    completed: entry.completed,
    eventOccurredAt: entry.eventOccurredAt,
  };
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
export const SEQUENCE_FLOOR_KEY = "\u0000device-sequence-floor";

/** `userId:bookId`. Book ids are uuids, so the separator is unambiguous. */
export function deviceSequenceKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}

export function activeUserId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    // A device with storage disabled still has to be able to play.
    return null;
  }
}
