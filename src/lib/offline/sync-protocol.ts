/**
 * The `GET /api/sync/pull` wire contract, shared by the route that produces it
 * and the mirror that applies it. Types and guards only, with no imports from
 * either side, so neither half drags the other into its bundle.
 *
 * Audio bytes and transcript payloads appear nowhere in this contract, and no
 * field carries a storage key or media URL. That is the hard boundary of
 * `docs/local-first.md` section 2, not an omission — the MP3 exists only on the
 * device that imported it and there is no route capable of moving it.
 */

export type PulledMedia = {
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  fingerprint: string;
  fingerprintKind: string;
  durationMs: number;
};

export type PulledChapter = {
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

/**
 * One book aggregate. Chapters and tag edges travel with their parent because
 * they carry no `updatedAt` of their own; a mutation to either bumps the
 * book's `updatedAt`, and the aggregate is then re-sent whole (section 3).
 */
export type PulledBook = {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  description: string | null;
  series: string | null;
  seriesPosition: string | null;
  chapterDiagnostic: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  media: PulledMedia | null;
  chapters: PulledChapter[];
  tagIds: string[];
};

export type PulledPlaybackState = {
  bookId: string;
  positionMs: number;
  playbackRate: number;
  completed: boolean;
  deviceId: string;
  deviceSequence: number;
  eventOccurredAt: string;
  updatedAt: string;
};

export type PulledTag = { id: string; name: string };

export type PulledCollection = {
  id: string;
  name: string;
  updatedAt: string;
  books: { bookId: string; position: number }[];
};

export type PulledPreferences = {
  skipBackMs: number;
  skipForwardMs: number;
  smartRewind: boolean;
  autoplayNextInCollection: boolean;
  updatedAt: string;
};

export type PulledListeningSession = {
  id: string;
  bookId: string;
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
  listenedMs: number;
};

/**
 * One deleted book. Emitted from the `book_tombstones` row written in the same
 * transaction as the delete, so a deletion is conveyed as an explicit statement
 * rather than as absence from a page (section 6).
 */
export type PulledTombstone = {
  bookId: string;
  deletedAt: string;
};

export type PullBatch = {
  /** Echo of the requested cursor; null on a first, full sync. */
  since: string | null;
  /** `max(updatedAt)` covered by this batch. Never advanced past unsent rows. */
  cursor: string;
  /** False when more book pages remain at or after `cursor`. */
  complete: boolean;
  books: PulledBook[];
  playbackStates: PulledPlaybackState[];
  /** Full vocabulary every pull; small and user-level (section 3). */
  tags: PulledTag[];
  /** Full list every pull, each with its complete membership. */
  collections: PulledCollection[];
  preferences: PulledPreferences | null;
  listeningSessions: PulledListeningSession[];
  /**
   * The complete, unpaged set of the user's live book ids — the deletion
   * oracle. Absence from a *page* means nothing, but absence from this list is
   * an explicit statement that the book is gone, so the mirror turns the
   * difference into explicit deletes. Null while pages remain, because sending
   * every id on every page is waste, not because it would be unsafe.
   */
  liveBookIds: string[] | null;
  /**
   * Per-row deletions since the requested cursor, from `book_tombstones`. This
   * is the scalable deletion signal: it costs one indexed range scan and grows
   * with the number of deletions rather than with the size of the library.
   *
   * Empty on a first, full sync (`since === null`) — there is nothing local to
   * tombstone, and the batch itself is the complete truth.
   *
   * Optional on the wire so a device running a build that predates it still
   * validates a batch, and so `liveBookIds` remains the fallback oracle until
   * every reader consumes tombstones.
   */
  tombstones?: PulledTombstone[];
};

export function isPullBatch(value: unknown): value is PullBatch {
  const batch = value as PullBatch | null;
  return (
    !!batch &&
    (batch.since === null || typeof batch.since === "string") &&
    typeof batch.cursor === "string" &&
    typeof batch.complete === "boolean" &&
    Array.isArray(batch.books) &&
    batch.books.every(isPulledBook) &&
    Array.isArray(batch.playbackStates) &&
    Array.isArray(batch.tags) &&
    Array.isArray(batch.collections) &&
    batch.collections.every((entry) => Array.isArray(entry?.books)) &&
    Array.isArray(batch.listeningSessions) &&
    (batch.preferences === null || typeof batch.preferences === "object") &&
    (batch.liveBookIds === null ||
      (Array.isArray(batch.liveBookIds) &&
        batch.liveBookIds.every((id) => typeof id === "string"))) &&
    (batch.tombstones === undefined ||
      (Array.isArray(batch.tombstones) && batch.tombstones.every(isPulledTombstone)))
  );
}

function isPulledTombstone(value: unknown): value is PulledTombstone {
  const tombstone = value as PulledTombstone | null;
  return (
    !!tombstone && typeof tombstone.bookId === "string" && typeof tombstone.deletedAt === "string"
  );
}

function isPulledBook(value: unknown): value is PulledBook {
  const book = value as PulledBook | null;
  return (
    !!book &&
    typeof book.id === "string" &&
    typeof book.title === "string" &&
    typeof book.updatedAt === "string" &&
    Array.isArray(book.chapters) &&
    Array.isArray(book.tagIds)
  );
}
