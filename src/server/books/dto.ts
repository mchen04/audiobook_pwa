import "server-only";

import type { LibraryBook } from "@/domain/library";
import type { PlaybackHistoryEntry } from "@/domain/player";
import type { listBooksForUser } from "@/server/books/queries";
import type { playbackActions } from "@/server/db/schema";

/**
 * Wire shapes the client consumes. Serializing here keeps the domain types the
 * single source of truth instead of ad-hoc casts on both sides.
 */
export function toPlaybackHistoryDto(
  row: Pick<
    typeof playbackActions.$inferSelect,
    | "id"
    | "action"
    | "positionMs"
    | "previousPositionMs"
    | "playbackRate"
    | "description"
    | "occurredAt"
    | "recordedAt"
  >,
): PlaybackHistoryEntry {
  return {
    id: row.id,
    action: row.action,
    positionMs: row.positionMs,
    previousPositionMs: row.previousPositionMs,
    playbackRate: Number(row.playbackRate),
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

type LibraryRow = Awaited<ReturnType<typeof listBooksForUser>>["books"][number];

export function toLibraryBookDto(row: LibraryRow): LibraryBook {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() || null,
    progressUpdatedAt: row.progressUpdatedAt?.toISOString() || null,
  };
}
