import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOfflineBook, projectOfflineBookmark, storeLocalBookMedia } from "./offline-library";

describe("offline bookmark projection", () => {
  beforeEach(() => {
    const media = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: vi.fn(async () => ({
        put: vi.fn(async (url: string, response: Response) => media.set(url, response)),
        match: vi.fn(async (url: string) => media.get(url)?.clone()),
        delete: vi.fn(async (url: string) => media.delete(url)),
      })),
    });
    vi.stubGlobal("navigator", { storage: {} });
  });

  it("keeps offline edits and deletions materialized across reopen", async () => {
    const book = {
      id: crypto.randomUUID(),
      title: "Book",
      author: "Author",
      durationMs: 8_000,
      chapters: [{ id: "chapter", position: 0, title: "Full", startMs: 0, endMs: 8_000 }],
      initialPositionMs: 0,
      initialProgressOccurredAt: null,
      initialPlaybackRate: 1,
      completed: false,
    };
    const bookmark = {
      id: crypto.randomUUID(),
      positionMs: 2_000,
      note: "original",
      createdAt: new Date().toISOString(),
    };
    await storeLocalBookMedia(
      "user-projection",
      book,
      new File([new Uint8Array([1, 2, 3])], "book.mp3", { type: "audio/mpeg" }),
      null,
      [bookmark],
    );

    await projectOfflineBookmark("user-projection", book.id, {
      kind: "upsert",
      bookmark: { ...bookmark, note: "edited offline" },
    });
    expect((await getOfflineBook("user-projection", book.id))?.bookmarks?.[0]?.note).toBe(
      "edited offline",
    );

    await projectOfflineBookmark("user-projection", book.id, {
      kind: "delete",
      bookmarkId: bookmark.id,
    });
    expect((await getOfflineBook("user-projection", book.id))?.bookmarks).toEqual([]);
  });

  it("replaces a pending bookmark with its canonical server record", async () => {
    const book = {
      id: crypto.randomUUID(),
      title: "Book",
      author: "Author",
      durationMs: 8_000,
      chapters: [{ id: "chapter", position: 0, title: "Full", startMs: 0, endMs: 8_000 }],
      initialPositionMs: 0,
      initialProgressOccurredAt: null,
      initialPlaybackRate: 1,
      completed: false,
    };
    await storeLocalBookMedia(
      "user-pending",
      book,
      new File([new Uint8Array([1])], "book.mp3", { type: "audio/mpeg" }),
      null,
      [],
    );
    const pending = {
      id: `pending:${crypto.randomUUID()}`,
      positionMs: 3_000,
      note: null,
      createdAt: new Date().toISOString(),
    };
    const canonical = { ...pending, id: crypto.randomUUID() };

    await projectOfflineBookmark("user-pending", book.id, {
      kind: "upsert",
      bookmark: pending,
    });
    await projectOfflineBookmark("user-pending", book.id, {
      kind: "delete",
      bookmarkId: pending.id,
    });
    await projectOfflineBookmark("user-pending", book.id, {
      kind: "upsert",
      bookmark: canonical,
    });

    expect((await getOfflineBook("user-pending", book.id))?.bookmarks).toEqual([canonical]);
  });
});
