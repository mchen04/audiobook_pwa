import type { IDBPTransaction } from "idb";

import {
  archiveMutationKey,
  buildMutation,
  collectionMutationKey,
  eventMutationKey,
  metadataMutationKey,
  newMutationId,
  queueMutation,
  tagMutationKey,
  type MutationDraft,
  type QueuedMutation,
} from "@/lib/offline-sync";

import {
  database,
  mirrorKey,
  mirrorPrefixRange,
  type MirrorBook,
  type MirrorBookTag,
  type MirrorCollectionBook,
  type MirrorPlaybackState,
  type MirrorTag,
  type OfflineDatabase,
} from "./db";

/**
 * Journal intent, then act.
 *
 * A mutation becomes durable in the outbox *before* the mirror is patched, so
 * the state the user is shown can never be one the server will not eventually
 * be told about. A crash between the two leaves an unapplied outbox row, which
 * replay delivers and the next pull mirrors — recoverable. The reverse order
 * would leave a mirrored change with no queued write, which is a lost write and
 * is not recoverable from anything.
 *
 * KNOWN DEVIATION from `docs/local-first.md` section 5 rule 1: the outbox lives
 * in `chapterline-sync-v1` and the mirror in `chapterline-offline-v1`, and
 * IndexedDB transactions cannot span two databases — `IDBDatabase.transaction`
 * takes store names within one connection and there is no cross-database
 * primitive in the specification. Section 4 keeps the two databases separate on
 * purpose, so "one transaction" for both is unimplementable as written. What is
 * implemented instead is the ordering that carries the same guarantee, and it
 * is the same shape `deletion-journal.ts` already uses (journal row committed,
 * then bytes removed). Within each database the write is a single transaction:
 * the outbox row lands atomically, and the whole mirror patch lands atomically
 * across every store it touches.
 */

const PATCH_STORES = [
  "books",
  "chapters",
  "bookTags",
  "playbackStates",
  "collections",
  "collectionBooks",
  "listeningSessions",
] as const;

type PatchStore = (typeof PATCH_STORES)[number];
export type MirrorPatchTransaction = IDBPTransaction<OfflineDatabase, PatchStore[], "readwrite">;
export type MirrorPatch = (transaction: MirrorPatchTransaction) => Promise<void>;

export type CommitResult = {
  /** The row that is durable in the outbox — the existing one when coalescing dropped this intent. */
  queued: QueuedMutation;
  /** True when the optimistic mirror patch also committed. */
  mirrored: boolean;
};

/**
 * Queues one mutation and optimistically patches the mirror.
 *
 * The outbox write is awaited first and is never rolled back by a mirror
 * failure: the user's intent stays recorded even if the local projection of it
 * could not be written.
 */
export async function commitMutation(
  mutation: QueuedMutation,
  patch: MirrorPatch | null = mirrorPatchFor(mutation),
): Promise<CommitResult> {
  const queued = await queueMutation(mutation);
  // Coalescing kept an existing row instead: the intent this call carried is
  // already superseded, so projecting it would move the mirror backwards.
  if (queued !== mutation || !patch) return { queued, mirrored: false };

  const db = await database();
  const transaction = db.transaction(PATCH_STORES as unknown as PatchStore[], "readwrite");
  try {
    await patch(transaction);
    await transaction.done;
  } catch (error) {
    abortQuietly(transaction);
    throw error;
  }
  return { queued, mirrored: true };
}

export function commitDraft(draft: MutationDraft, patch?: MirrorPatch | null) {
  const mutation = buildMutation(draft);
  return commitMutation(mutation, patch === undefined ? mirrorPatchFor(mutation) : patch);
}

// ---------------------------------------------------------------------------
// The mutation API
// ---------------------------------------------------------------------------

/**
 * These are the only supported ways to make a mutation, and the only reason
 * they exist is that the coalesce key must not be a caller's responsibility.
 *
 * The key is the load-bearing half of the coalescing rules: the policy table
 * says `import`, `delete` and `history` never coalesce, but what *enforces* it
 * is that `eventMutationKey` puts the `mutationId` in the key so two distinct
 * events cannot collide. A call site that hand-assembled a key could silently
 * drop the `mutationId`, and the policy branch that would have saved it is
 * unreachable — two rows would simply become one, and one user write would be
 * gone. Routing every mutation through a builder is what makes that
 * unrepresentable rather than merely discouraged.
 */

type Origin = { userId: string; deviceId: string };

export function commitMetadataEdit(
  origin: Origin,
  bookId: string,
  fields: Record<string, unknown>,
) {
  return commitDraft({
    key: metadataMutationKey(origin.userId, bookId),
    userId: origin.userId,
    kind: "metadata",
    entityId: bookId,
    payload: fields,
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

export function commitArchiveChange(origin: Origin, bookId: string, archived: boolean) {
  return commitDraft({
    key: archiveMutationKey(origin.userId, bookId),
    userId: origin.userId,
    kind: "archive",
    entityId: bookId,
    payload: { archived },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

/**
 * One book↔tag edge.
 *
 * The tag's *name* is resolved from the mirror and queued alongside its id,
 * which is what makes the intent self-sufficient. A tag id is not stable across
 * the gap between queueing and replay: the server garbage-collects a tag the
 * moment no book references it, so "remove fiction, then add it back" — or
 * another device saving a book's whole tag list in between — can delete the row
 * this edge names. Replaying an id that no longer exists would 404, and a 4xx
 * is terminal, so the write would be dropped. With the name aboard, the server
 * can re-establish the vocabulary entry and the edge still lands.
 */
export async function commitTagEdge(
  origin: Origin,
  bookId: string,
  tagId: string,
  include: boolean,
) {
  const db = await database();
  const tag = await db.get("tags", mirrorKey(origin.userId, tagId));
  return commitDraft({
    key: tagMutationKey(origin.userId, bookId, tagId),
    userId: origin.userId,
    kind: "tag",
    entityId: bookId,
    payload: { tagId, include, ...(tag ? { name: tag.name } : {}) },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

/**
 * The details dialog's whole-tag-list field, expressed as edges.
 *
 * The dialog offers a comma-separated list of *names*, but the queued form has
 * to be per-edge. A `tags: [...]` replacement would be the last writer to reach
 * the server wiping every tag another device added while this one was offline,
 * which is precisely the conflict the design contract's section 7 resolves as
 * add-wins-per-edge. Only what the user actually changed is queued.
 *
 * A name with no id in the mirror — a tag being invented right now, or one this
 * device has never pulled — gets a locally minted id and a mirror vocabulary
 * row. The id is a guess the server is free to ignore: `resolveEdgeTag` falls
 * back to the name, re-establishing or creating the entry, and the next pull
 * replaces the guess with the real row. Minting it locally is what lets the new
 * chip appear on this device immediately instead of after a round trip.
 */
export async function commitTagList(
  origin: Origin,
  bookId: string,
  previous: string[],
  next: string[],
): Promise<void> {
  const before = new Map(previous.map((name) => [name.trim().toLowerCase(), name.trim()]));
  const after = new Map(next.map((name) => [name.trim().toLowerCase(), name.trim()]));
  before.delete("");
  after.delete("");

  const db = await database();
  const vocabulary = await db.getAllFromIndex("tags", "by-user", origin.userId);
  const idByName = new Map(vocabulary.map((tag) => [tag.name.toLowerCase(), tag.tagId]));

  for (const [lowered] of before) {
    if (after.has(lowered)) continue;
    const tagId = idByName.get(lowered);
    // Nothing local names this tag, so there is no edge to express. The book's
    // own tag list is re-read from the next pull either way.
    if (tagId) await commitTagEdge(origin, bookId, tagId, false);
  }
  for (const [lowered, name] of after) {
    if (before.has(lowered)) continue;
    let tagId = idByName.get(lowered);
    if (!tagId) {
      tagId = crypto.randomUUID();
      const record: MirrorTag = {
        key: mirrorKey(origin.userId, tagId),
        userId: origin.userId,
        tagId,
        name,
      };
      await db.put("tags", record);
      idByName.set(lowered, tagId);
    }
    await commitTagEdge(origin, bookId, tagId, true);
  }
}

export function commitCollectionEdge(
  origin: Origin,
  collectionId: string,
  bookId: string,
  include: boolean,
) {
  return commitDraft({
    key: collectionMutationKey(origin.userId, collectionId, bookId),
    userId: origin.userId,
    kind: "collection",
    entityId: collectionId,
    payload: { bookId, include },
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

/**
 * The three distinct-event kinds. Each mints its own `mutationId` and hands it
 * to `eventMutationKey`, so two calls can never produce the same key — which is
 * the whole mechanism by which they refuse to coalesce.
 */
function commitDistinctEvent(
  origin: Origin,
  kind: "import" | "delete" | "history",
  entityId: string,
  payload: Record<string, unknown>,
) {
  const mutationId = newMutationId();
  return commitDraft({
    key: eventMutationKey(origin.userId, kind, entityId, mutationId),
    userId: origin.userId,
    kind,
    entityId,
    payload,
    mutationId,
    deviceId: origin.deviceId,
    deviceSequence: 0,
  });
}

export function commitImport(
  origin: Origin,
  fingerprint: string,
  payload: Record<string, unknown>,
) {
  return commitDistinctEvent(origin, "import", fingerprint, payload);
}

export function commitBookDeletion(origin: Origin, bookId: string) {
  return commitDistinctEvent(origin, "delete", bookId, {});
}

export function commitHistoryEvent(origin: Origin, bookId: string, event: Record<string, unknown>) {
  return commitDistinctEvent(origin, "history", bookId, event);
}

function abortQuietly(transaction: MirrorPatchTransaction): void {
  void transaction.done.catch(() => undefined);
  try {
    transaction.abort();
  } catch {
    // A failing request already aborted it; same outcome.
  }
}

// ---------------------------------------------------------------------------
// Optimistic mirror projections
// ---------------------------------------------------------------------------

/**
 * The local projection of each mutation kind.
 *
 * `import` and `history` have none: an import has no book id until the server
 * assigns one, and playback history is not mirrored at all (section 2). Both
 * still go through the outbox, which is what makes them durable.
 *
 * Every projection that touches a book's children also bumps that book's
 * `updatedAt`, mirroring the server rule from section 3 — otherwise the local
 * copy would order differently from the one the next pull delivers.
 */
export function mirrorPatchFor(mutation: QueuedMutation): MirrorPatch | null {
  const { userId, entityId, payload } = mutation;
  const now = new Date().toISOString();
  switch (mutation.kind) {
    case "metadata":
    case "archive":
      return async (transaction) => {
        await patchBook(transaction, userId, entityId, (book) => ({
          ...book,
          ...bookFieldsFrom(payload),
          updatedAt: now,
        }));
      };
    case "tag":
      return async (transaction) => {
        const tagId = String(payload.tagId ?? "");
        const key = mirrorKey(userId, entityId, tagId);
        const edges = transaction.objectStore("bookTags");
        if (payload.include === false) await edges.delete(key);
        else {
          const edge: MirrorBookTag = { key, userId, bookId: entityId, tagId };
          await edges.put(edge);
        }
        await patchBook(transaction, userId, entityId, (book) => ({ ...book, updatedAt: now }));
      };
    case "collection":
      return async (transaction) => {
        const bookId = String(payload.bookId ?? "");
        const key = mirrorKey(userId, entityId, bookId);
        const edges = transaction.objectStore("collectionBooks");
        if (payload.include === false) await edges.delete(key);
        else {
          const existing = await edges.get(key);
          const member: MirrorCollectionBook = existing || {
            key,
            userId,
            collectionId: entityId,
            bookId,
            position: (await edges.index("by-user-collection").count([userId, entityId])) || 0,
          };
          await edges.put(member);
        }
        const collections = transaction.objectStore("collections");
        const collection = await collections.get(mirrorKey(userId, entityId));
        if (collection) await collections.put({ ...collection, updatedAt: now });
      };
    case "progress":
      return async (transaction) => {
        const store = transaction.objectStore("playbackStates");
        const key = mirrorKey(userId, entityId);
        const existing = await store.get(key);
        if (existing && existing.deviceSequence > mutation.deviceSequence) return;
        const state: MirrorPlaybackState = {
          key,
          userId,
          bookId: entityId,
          positionMs: Number(payload.positionMs ?? existing?.positionMs ?? 0),
          playbackRate: Number(payload.playbackRate ?? existing?.playbackRate ?? 1),
          completed: Boolean(payload.completed ?? existing?.completed ?? false),
          deviceId: mutation.deviceId,
          deviceSequence: mutation.deviceSequence,
          eventOccurredAt: String(payload.eventOccurredAt ?? now),
          updatedAt: now,
        };
        await store.put(state);
      };
    case "delete":
      return (transaction) => removeBookAggregate(transaction, userId, entityId);
    default:
      return null;
  }
}

function bookFieldsFrom(payload: Record<string, unknown>): Partial<MirrorBook> {
  const fields: Partial<MirrorBook> = {};
  for (const field of ["title", "author", "narrator", "description", "series"] as const) {
    if (field in payload) fields[field] = payload[field] as never;
  }
  if ("seriesPosition" in payload) {
    const value = payload.seriesPosition;
    fields.seriesPosition = value === null ? null : Number(value).toFixed(2);
  }
  if ("archived" in payload) {
    fields.archivedAt = payload.archived ? new Date().toISOString() : null;
  }
  return fields;
}

async function patchBook(
  transaction: MirrorPatchTransaction,
  userId: string,
  bookId: string,
  update: (book: MirrorBook) => MirrorBook,
): Promise<void> {
  const store = transaction.objectStore("books");
  const key = mirrorKey(userId, bookId);
  const existing = await store.get(key);
  if (!existing) return;
  const next = update(existing);
  await store.put({ ...next, searchText: searchTextFor(next) });
}

/** Matches `mirror.ts#searchTextFor`; a rename must stay searchable immediately. */
function searchTextFor(book: MirrorBook): string {
  return [book.title, book.author, book.narrator || "", book.series || ""].join(" ").toLowerCase();
}

/**
 * Removes one book and everything that hangs off it. Media bytes and
 * transcripts are deliberately not touched here: this is a metadata projection,
 * and the only copy of the audio is removed through `removeOfflineBook`'s
 * journal, never as a side effect of sync bookkeeping.
 */
async function removeBookAggregate(
  transaction: MirrorPatchTransaction,
  userId: string,
  bookId: string,
): Promise<void> {
  const collectionBooks = transaction.objectStore("collectionBooks");
  const listeningSessions = transaction.objectStore("listeningSessions");
  const [edgeKeys, sessionKeys] = await Promise.all([
    collectionBooks.index("by-user").getAllKeys(userId),
    listeningSessions.index("by-user-book").getAllKeys([userId, bookId]),
  ]);
  await Promise.all([
    transaction.objectStore("books").delete(mirrorKey(userId, bookId)),
    transaction.objectStore("playbackStates").delete(mirrorKey(userId, bookId)),
    transaction.objectStore("chapters").delete(mirrorPrefixRange(userId, bookId)),
    transaction.objectStore("bookTags").delete(mirrorPrefixRange(userId, bookId)),
    ...edgeKeys
      .filter((key) => key.slice(key.lastIndexOf(":") + 1) === bookId)
      .map((key) => collectionBooks.delete(key)),
    ...sessionKeys.map((key) => listeningSessions.delete(key)),
  ]);
}
