const PROGRESS_QUEUE_KEY = "chapterline:progress-queue";
const BOOKMARK_QUEUE_KEY = "chapterline:bookmark-queue";
const PROGRESS_QUEUE_LIMIT = 100;
const BOOKMARK_QUEUE_LIMIT = 200;

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
};

/** The wire body for a progress PATCH; built here so no caller drifts. */
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

export function queueProgress(entry: QueuedProgress): void {
  writeQueue(
    PROGRESS_QUEUE_KEY,
    [...readQueue<QueuedProgress>(PROGRESS_QUEUE_KEY), entry].slice(-PROGRESS_QUEUE_LIMIT),
  );
}

export function queueBookmark(entry: QueuedBookmark): void {
  writeQueue(
    BOOKMARK_QUEUE_KEY,
    [...readQueue<QueuedBookmark>(BOOKMARK_QUEUE_KEY), entry].slice(-BOOKMARK_QUEUE_LIMIT),
  );
}

export function queuedBookmarksFor(userId: string, bookId: string): QueuedBookmark[] {
  return readQueue<QueuedBookmark>(BOOKMARK_QUEUE_KEY).filter(
    (entry) => entry.userId === userId && entry.bookId === bookId,
  );
}

export function updateQueuedBookmarkNote(
  userId: string,
  clientId: string,
  note: string | null,
): void {
  writeQueue(
    BOOKMARK_QUEUE_KEY,
    readQueue<QueuedBookmark>(BOOKMARK_QUEUE_KEY).map((entry) =>
      entry.userId === userId && entry.clientId === clientId ? { ...entry, note } : entry,
    ),
  );
}

export function removeQueuedBookmark(userId: string, clientId: string): void {
  writeQueue(
    BOOKMARK_QUEUE_KEY,
    readQueue<QueuedBookmark>(BOOKMARK_QUEUE_KEY).filter(
      (entry) => entry.userId !== userId || entry.clientId !== clientId,
    ),
  );
}

/**
 * Replays queued offline mutations for one user. Entries are dropped once the
 * server answers (any status: the server owns conflict resolution and replay is
 * idempotent via device sequences and bookmark client ids) and kept only when
 * the network itself fails. Entries for other users are preserved untouched.
 */
export async function replayQueuedMutations(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const progressRemaining: QueuedProgress[] = [];
  for (const entry of readQueue<QueuedProgress>(PROGRESS_QUEUE_KEY)) {
    if (entry.userId !== userId) {
      progressRemaining.push(entry);
      continue;
    }
    try {
      await fetchFn(`/api/books/${entry.bookId}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: toProgressBody(entry),
      });
    } catch {
      progressRemaining.push(entry);
    }
  }
  writeQueue(PROGRESS_QUEUE_KEY, progressRemaining);

  const bookmarksRemaining: QueuedBookmark[] = [];
  for (const entry of readQueue<QueuedBookmark>(BOOKMARK_QUEUE_KEY)) {
    if (entry.userId !== userId) {
      bookmarksRemaining.push(entry);
      continue;
    }
    try {
      await fetchFn(`/api/books/${entry.bookId}/bookmarks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: entry.clientId,
          positionMs: entry.positionMs,
          note: entry.note,
        }),
      });
    } catch {
      bookmarksRemaining.push(entry);
    }
  }
  writeQueue(BOOKMARK_QUEUE_KEY, bookmarksRemaining);
}

function readQueue<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(key: string, entries: unknown[]): void {
  localStorage.setItem(key, JSON.stringify(entries));
}
