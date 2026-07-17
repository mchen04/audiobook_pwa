import { beforeEach, describe, expect, it, vi } from "vitest";

const { storeLocalBookMedia } = vi.hoisted(() => ({ storeLocalBookMedia: vi.fn() }));

vi.mock("@/lib/offline/media-store", () => ({ storeLocalBookMedia }));
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
  }),
}));

import { importLocalMp3 } from "./local-import";

describe("local MP3 import", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

    expect(storeLocalBookMedia).toHaveBeenCalledWith("mobile-user", canonical, file, null);
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
