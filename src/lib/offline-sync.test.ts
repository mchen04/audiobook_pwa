import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  queueBookmark,
  queuedBookmarksFor,
  queueProgress,
  removeQueuedBookmark,
  replayQueuedMutations,
  type QueuedBookmark,
  type QueuedProgress,
} from "./offline-sync";

function localStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as Storage;
}

function progressEntry(overrides: Partial<QueuedProgress> = {}): QueuedProgress {
  return {
    userId: "user-a",
    bookId: "book-1",
    deviceId: "device-1",
    deviceSequence: 1,
    positionMs: 5_000,
    playbackRate: 1.5,
    completed: false,
    eventOccurredAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function bookmarkEntry(overrides: Partial<QueuedBookmark> = {}): QueuedBookmark {
  return {
    userId: "user-a",
    bookId: "book-1",
    clientId: "11111111-1111-4111-8111-111111111111",
    positionMs: 2_000,
    note: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageStub());
});

describe("offline mutation queues", () => {
  it("replays queued progress and bookmarks once the network answers", async () => {
    queueProgress(progressEntry());
    queueBookmark(bookmarkEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [progressUrl, progressInit] = fetchFn.mock.calls[0] ?? [];
    expect(progressUrl).toBe("/api/books/book-1/progress");
    expect(JSON.parse(progressInit.body as string).deviceSequence).toBe(1);
    const [bookmarkUrl, bookmarkInit] = fetchFn.mock.calls[1] ?? [];
    expect(bookmarkUrl).toBe("/api/books/book-1/bookmarks");
    expect(JSON.parse(bookmarkInit.body as string).clientId).toBe(bookmarkEntry().clientId);

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("drops entries the server rejected instead of retrying forever", async () => {
    queueProgress(progressEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps entries when the network itself fails", async () => {
    queueProgress(progressEntry());
    const failing = vi.fn().mockRejectedValue(new TypeError("offline"));

    await replayQueuedMutations("user-a", failing as typeof fetch);
    expect(failing).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("never replays or removes another user's queued mutations", async () => {
    queueBookmark(bookmarkEntry({ userId: "user-b" }));
    queueBookmark(bookmarkEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queuedBookmarksFor("user-b", "book-1")).toHaveLength(1);
    expect(queuedBookmarksFor("user-a", "book-1")).toHaveLength(0);
  });

  it("lists and removes queued bookmarks by user and client id", () => {
    const entry = bookmarkEntry();
    queueBookmark(entry);
    expect(queuedBookmarksFor("user-a", "book-1")).toEqual([entry]);

    removeQueuedBookmark("user-b", entry.clientId);
    expect(queuedBookmarksFor("user-a", "book-1")).toHaveLength(1);

    removeQueuedBookmark("user-a", entry.clientId);
    expect(queuedBookmarksFor("user-a", "book-1")).toHaveLength(0);
  });

  it("survives corrupted queue storage", async () => {
    localStorage.setItem("chapterline:progress-queue", "{not json");
    const fetchFn = vi.fn();
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
