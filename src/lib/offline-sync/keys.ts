import type { QueuedProgress } from "./db";

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
