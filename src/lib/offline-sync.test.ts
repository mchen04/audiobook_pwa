import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import { getOfflineBook, projectOfflineBookmark, storeLocalBookMedia } from "./offline-library";

import {
  queueBookmark,
  queueBookmarkClientDelete,
  queueBookmarkDelete,
  queueBookmarkUpdate,
  completeBookmarkUpdate,
  completeBookmarkClientDeleteIfPresent,
  clearQueuedMutationsForUser,
  queuedBookmarksFor,
  queueProgress,
  nextDeviceSequence,
  removeQueuedBookmark,
  replayQueuedMutations,
  updateQueuedBookmarkNote,
  withBookmarkMutationLock,
  type QueuedBookmark,
  type QueuedProgress,
} from "./offline-sync";

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
    revision: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearQueuedMutationsForUser("user-a");
  await clearQueuedMutationsForUser("user-b");
});

describe("offline mutation queues", () => {
  it("replays queued progress and bookmarks once the network answers", async () => {
    await queueProgress(progressEntry());
    await queueBookmark(bookmarkEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [progressUrl, progressInit] =
      fetchFn.mock.calls.find(([url]) => String(url).endsWith("/progress")) ?? [];
    expect(progressUrl).toBe("/api/books/book-1/progress");
    expect(JSON.parse(progressInit.body as string).deviceSequence).toBe(1);
    const [bookmarkUrl, bookmarkInit] =
      fetchFn.mock.calls.find(([url]) => String(url).endsWith("/bookmarks")) ?? [];
    expect(bookmarkUrl).toBe("/api/books/book-1/bookmarks");
    expect(JSON.parse(bookmarkInit.body as string).clientId).toBe(bookmarkEntry().clientId);

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("drops terminal conflicts instead of retrying forever", async () => {
    await queueProgress(progressEntry());
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: vi.fn().mockReturnValue(null) });
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json(
        {
          state: {
            positionMs: 7_000,
            completed: true,
            playbackRate: "1.25",
            eventOccurredAt: "2026-07-09T01:00:00.000Z",
          },
        },
        { status: 409 },
      ),
    );

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(
      expect.stringContaining("user-a:book-1"),
      expect.stringContaining('"positionMs":7000'),
    );
  });

  it("does not apply a progress conflict over a newer local sequence", async () => {
    const bookId = "book-with-newer-local-progress";
    await nextDeviceSequence(bookId);
    await nextDeviceSequence(bookId);
    await queueProgress(progressEntry({ bookId, deviceSequence: 1 }));
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: vi.fn().mockReturnValue(null) });
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json(
        {
          state: {
            positionMs: 1_000,
            completed: false,
            playbackRate: "1",
            eventOccurredAt: "2026-07-09T01:00:00.000Z",
          },
        },
        { status: 409 },
      ),
    );

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps transient server failures queued until a later success", async () => {
    await queueProgress(progressEntry());
    await queueBookmark(bookmarkEntry());
    const unavailable = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    expect(unavailable).toHaveBeenCalledTimes(4);

    const succeeding = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    expect(succeeding).toHaveBeenCalledTimes(2);
  });

  it("drops terminal validation failures", async () => {
    await queueBookmark(bookmarkEntry());
    const invalid = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

    await replayQueuedMutations("user-a", invalid as typeof fetch);
    await replayQueuedMutations("user-a", invalid as typeof fetch);

    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("retains mutations blocked by auth status %i", async (status) => {
    await queueProgress(progressEntry());
    await queueBookmark(bookmarkEntry());
    const blocked = vi.fn().mockResolvedValue(new Response(null, { status }));

    await replayQueuedMutations("user-a", blocked as typeof fetch);
    await replayQueuedMutations("user-a", blocked as typeof fetch);

    expect(blocked).toHaveBeenCalledTimes(4);
    expect(await queuedBookmarksFor("user-a", "book-1")).toHaveLength(1);
  });

  it("keeps entries when the network itself fails", async () => {
    await queueProgress(progressEntry());
    const failing = vi.fn().mockRejectedValue(new TypeError("offline"));

    await replayQueuedMutations("user-a", failing as typeof fetch);
    expect(failing).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("compacts progress to the newest device sequence", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1, positionMs: 1_000 }));
    await queueProgress(progressEntry({ deviceSequence: 3, positionMs: 3_000 }));
    await queueProgress(progressEntry({ deviceSequence: 2, positionMs: 2_000 }));
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).deviceSequence).toBe(3);
  });

  it("does not erase a mutation queued while replay is in flight", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1 }));
    const fetchFn = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      await queueProgress(progressEntry({ deviceSequence: 2 }));
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body as string).deviceSequence).toBe(2);
  });

  it("does not erase a bookmark note edited while replay is in flight", async () => {
    await queueBookmark(bookmarkEntry());
    const fetchFn = vi.fn(async () => {
      await updateQueuedBookmarkNote("user-a", bookmarkEntry().clientId, "newest note");
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    expect(await queuedBookmarksFor("user-a", "book-1")).toMatchObject([
      { note: "newest note", revision: 2 },
    ]);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent replay triggers for one user", async () => {
    await queueBookmark(bookmarkEntry());
    let resolveRequest: ((response: Response) => void) | undefined;
    const fetchFn = vi.fn(
      () => new Promise<Response>((resolve) => void (resolveRequest = resolve)),
    );

    const first = replayQueuedMutations("user-a", fetchFn as typeof fetch);
    const second = replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    resolveRequest?.(new Response(null, { status: 200 }));
    await Promise.all([first, second]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("never replays or removes another user's queued mutations", async () => {
    await queueBookmark(bookmarkEntry({ userId: "user-b" }));
    await queueBookmark(bookmarkEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await queuedBookmarksFor("user-b", "book-1")).toHaveLength(1);
    expect(await queuedBookmarksFor("user-a", "book-1")).toHaveLength(0);
  });

  it("lists and removes queued bookmarks by user and client id", async () => {
    const entry = bookmarkEntry();
    await queueBookmark(entry);
    expect(await queuedBookmarksFor("user-a", "book-1")).toEqual([entry]);

    await removeQueuedBookmark("user-b", entry.clientId);
    expect(await queuedBookmarksFor("user-a", "book-1")).toHaveLength(1);

    await removeQueuedBookmark("user-a", entry.clientId);
    expect(await queuedBookmarksFor("user-a", "book-1")).toHaveLength(0);
  });

  it("allocates device sequences transactionally", async () => {
    await expect(
      Promise.all([nextDeviceSequence("book-1"), nextDeviceSequence("book-1")]),
    ).resolves.toEqual(expect.arrayContaining([1, 2]));
  });

  it("does not silently evict a large offline bookmark set", async () => {
    await Promise.all(
      Array.from({ length: 250 }, (_, index) =>
        queueBookmark(
          bookmarkEntry({
            clientId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
      ),
    );
    expect(await queuedBookmarksFor("user-a", "book-1")).toHaveLength(250);
  });

  it("durably replays edits and deletions of existing bookmarks", async () => {
    await queueBookmarkUpdate({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-edit",
      note: "offline edit",
    });
    await queueBookmarkDelete({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-delete",
    });
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          "/api/books/book-1/bookmarks/bookmark-edit",
          expect.objectContaining({ method: "PATCH" }),
        ]),
        expect.arrayContaining([
          "/api/books/book-1/bookmarks/bookmark-delete",
          expect.objectContaining({ method: "DELETE" }),
        ]),
      ]),
    );
  });

  it("completes a successful note replay when cross-tab storage is blocked", async () => {
    await queueBookmarkUpdate({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-edit",
      note: "synced note",
      previousNote: "old note",
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("localStorage", {
      setItem: vi.fn(() => {
        throw new DOMException("Blocked", "SecurityError");
      }),
      removeItem: vi.fn(),
    });
    const fetchFn = vi.fn().mockResolvedValue(
      Response.json({
        bookmark: {
          id: "bookmark-edit",
          positionMs: 2_000,
          note: "synced note",
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      }),
    );

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("coalesces an offline edit into a later deletion", async () => {
    await queueBookmarkUpdate({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-1",
      note: "discarded edit",
    });
    await queueBookmarkDelete({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-1",
    });
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("does not authorize an update rollback after a newer delete", async () => {
    const update = await queueBookmarkUpdate({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-1",
      note: "in flight",
    });
    await queueBookmarkDelete({
      userId: "user-a",
      bookId: "book-1",
      bookmarkId: "bookmark-1",
    });

    await expect(completeBookmarkUpdate(update)).resolves.toBe(false);
  });

  it("persists deletion intent for an in-flight client bookmark", async () => {
    const pending = bookmarkEntry();
    await queueBookmark(pending);
    await queueBookmarkClientDelete({
      userId: pending.userId,
      bookId: pending.bookId,
      clientId: pending.clientId,
    });
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toContain(`/bookmarks?clientId=${pending.clientId}`);
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("finishes a client-id deletion queued while bookmark creation is in flight", async () => {
    const pending = bookmarkEntry();
    await queueBookmark(pending);
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("?clientId=")) return new Response(null, { status: 204 });
      await queueBookmarkClientDelete({
        userId: pending.userId,
        bookId: pending.bookId,
        clientId: pending.clientId,
      });
      return Response.json({
        bookmark: {
          id: "canonical-race-bookmark",
          positionMs: pending.positionMs,
          note: null,
          createdAt: pending.createdAt,
        },
      });
    });

    await replayQueuedMutations(pending.userId, fetchFn as typeof fetch);
    await replayQueuedMutations(pending.userId, fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[0]).toContain(`?clientId=${pending.clientId}`);
  });

  it("discards a client-delete tombstone after its create fails terminally", async () => {
    const pending = bookmarkEntry();
    await queueBookmarkClientDelete({
      userId: pending.userId,
      bookId: pending.bookId,
      clientId: pending.clientId,
    });
    await completeBookmarkClientDeleteIfPresent(
      pending,
      vi.fn().mockResolvedValue(Response.json({ bookmarkId: null })) as typeof fetch,
      true,
    );
    const fetchFn = vi.fn();

    await replayQueuedMutations(pending.userId, fetchFn as typeof fetch);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("projects background create, update, and delete replay into the offline book", async () => {
    const media = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn(async (url: string, response: Response) => media.set(url, response)),
        match: vi.fn(async (url: string) => media.get(url)?.clone()),
        delete: vi.fn(async (url: string) => media.delete(url)),
      })),
    });
    vi.stubGlobal("navigator", { storage: {} });
    const userId = "user-replay-projection";
    const bookId = "book-replay-projection";
    const queued = bookmarkEntry({ userId, bookId });
    const pending = {
      id: `pending:${queued.clientId}`,
      positionMs: queued.positionMs,
      note: queued.note,
      createdAt: queued.createdAt,
    };
    const canonical = { ...pending, id: "canonical-bookmark" };
    await storeLocalBookMedia(
      userId,
      {
        id: bookId,
        title: "Book",
        author: "Author",
        durationMs: 8_000,
        chapters: [],
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 1,
        completed: false,
      },
      new File([new Uint8Array([1])], "book.mp3", { type: "audio/mpeg" }),
      null,
      [],
    );
    await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark: pending });
    await queueBookmark(queued);

    await replayQueuedMutations(
      userId,
      vi
        .fn()
        .mockResolvedValue(Response.json({ bookmark: canonical }, { status: 201 })) as typeof fetch,
    );
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([canonical]);

    const edited = { ...canonical, note: "synced note" };
    await queueBookmarkUpdate({ userId, bookId, bookmarkId: canonical.id, note: edited.note });
    await replayQueuedMutations(
      userId,
      vi.fn().mockResolvedValue(Response.json({ bookmark: edited })) as typeof fetch,
    );
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([edited]);

    await projectOfflineBookmark(userId, bookId, {
      kind: "upsert",
      bookmark: { ...edited, note: "invalid optimistic note" },
    });
    await queueBookmarkUpdate({
      userId,
      bookId,
      bookmarkId: canonical.id,
      note: "invalid optimistic note",
      previousNote: edited.note,
    });
    await replayQueuedMutations(
      userId,
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "Invalid note" }, { status: 400 }),
        ) as typeof fetch,
    );
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([edited]);

    await queueBookmarkUpdate({ userId, bookId, bookmarkId: canonical.id, note: "stale success" });
    let resolveStaleUpdate: ((response: Response) => void) | undefined;
    const staleUpdateReplay = replayQueuedMutations(
      userId,
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveStaleUpdate = resolve;
          }),
      ) as typeof fetch,
    );
    await vi.waitFor(() => expect(resolveStaleUpdate).toBeTypeOf("function"));
    const deleteAfterUpdate = withBookmarkMutationLock(userId, bookId, canonical.id, async () => {
      await queueBookmarkDelete({ userId, bookId, bookmarkId: canonical.id });
      await projectOfflineBookmark(userId, bookId, {
        kind: "delete",
        bookmarkId: canonical.id,
      });
    });
    resolveStaleUpdate?.(Response.json({ bookmark: { ...edited, note: "stale success" } }));
    await Promise.all([staleUpdateReplay, deleteAfterUpdate]);
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([]);
    await replayQueuedMutations(
      userId,
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch,
    );

    await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark: edited });
    await queueBookmarkUpdate({ userId, bookId, bookmarkId: canonical.id, note: "stale note" });
    await replayQueuedMutations(
      userId,
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 })) as typeof fetch,
    );
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([]);

    await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark: edited });
    await queueBookmarkDelete({ userId, bookId, bookmarkId: canonical.id });
    await replayQueuedMutations(
      userId,
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch,
    );
    expect((await getOfflineBook(userId, bookId))?.bookmarks).toEqual([]);
  });
});
