import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

// An import journals its registration in the outbox before it touches the
// network, so the module under test needs the two browser globals that write
// reaches for: IndexedDB for the queue, and localStorage for the device id it
// attributes the mutation to.
const { storeLocalBookMedia } = vi.hoisted(() => ({ storeLocalBookMedia: vi.fn() }));

// Only the byte-writing half is stubbed. `withLocalMediaSlot` is the REAL one,
// so the lock the import holds across its whole local write is the lock the
// product takes — a stub of it would quietly delete the ordering guarantee that
// keeps a concurrent reattach out of the middle of an import.
vi.mock("@/lib/offline/media-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/media-store")>()),
  storeLocalBookMedia,
}));
vi.mock("music-metadata", () => ({
  parseBlob: vi.fn().mockResolvedValue({
    format: {
      hasAudio: true,
      hasVideo: false,
      container: "MPEG",
      codec: "MPEG 1 Layer 3",
      duration: 8,
    },
    common: { title: "Mobile PWA Fixture", artist: "Ada Mobile" },
    native: {},
    quality: { warnings: [] },
  }),
}));

import { importLocalMp3 } from "./local-import";

describe("local MP3 import", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.stubGlobal("localStorage", memoryStorage());
    storeLocalBookMedia.mockReset().mockResolvedValue(undefined);
  });

  it("reattaches device media when the same MP3 is already registered", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: "This MP3 is already in your library.", existingBookId: "existing-book" },
          { status: 409 },
        ),
      );
    const file = new File([new Uint8Array([1, 2, 3])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledWith(
      "mobile-user",
      expect.objectContaining({
        id: "existing-book",
        title: "Mobile PWA Fixture",
        author: "Ada Mobile",
      }),
      file,
      null,
      expect.any(Function),
      // The slot the import holds names the id this device MINTED, not the one
      // the server answered with: everything written under the minted id has to
      // be inside one slot for a later reattach to be able to move all of it.
      { key: expect.stringMatching(/^mobile-user:[0-9a-f-]{36}$/) },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses canonical synced state when reattaching an existing book", async () => {
    const canonical = {
      id: "existing-book",
      title: "Edited title",
      author: "Edited author",
      durationMs: 8_000,
      chapters: [{ id: "chapter-1", position: 0, title: "One", startMs: 0, endMs: 8_000 }],
      initialPositionMs: 6_000,
      initialProgressOccurredAt: "2026-07-10T12:00:00.000Z",
      initialPlaybackRate: 1.5,
      completed: false,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        {
          error: "This MP3 is already in your library.",
          existingBookId: canonical.id,
          playerBook: canonical,
        },
        { status: 409 },
      ),
    );
    const file = new File([new Uint8Array([1, 2, 3])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await importLocalMp3("mobile-user", file, vi.fn());

    expect(storeLocalBookMedia).toHaveBeenCalledWith(
      "mobile-user",
      canonical,
      file,
      null,
      expect.any(Function),
      { key: expect.stringMatching(/^mobile-user:[0-9a-f-]{36}$/) },
    );
  });

  it("keeps recoverable metadata when device storage fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ bookId: "new-book" }, { status: 201 }));
    storeLocalBookMedia.mockRejectedValueOnce(new Error("storage failed"));
    const file = new File([new Uint8Array([4, 5, 6])], "fixture.mp3", {
      type: "audio/mpeg",
    });

    await expect(importLocalMp3("mobile-user", file, vi.fn())).rejects.toThrow(
      "Choose the same MP3 again to finish saving it",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}
