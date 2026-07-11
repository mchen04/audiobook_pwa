import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerChapter } from "@/domain/player";

import {
  freshestPosition,
  isChapterEnding,
  readLocalPosition,
  resolveStartPosition,
  rewindForAbsence,
  saveLocalPosition,
  selectCurrentChapter,
} from "./playback-core";

const chapters: PlayerChapter[] = [
  { id: "a", position: 0, title: "One", startMs: 0, endMs: 20_000 },
  { id: "b", position: 1, title: "Two", startMs: 20_000, endMs: 40_000 },
  { id: "c", position: 2, title: "Three", startMs: 40_000, endMs: 60_000 },
];

describe("selectCurrentChapter", () => {
  it("picks the containing chapter and treats boundaries as the next chapter", () => {
    expect(selectCurrentChapter(chapters, 0)?.id).toBe("a");
    expect(selectCurrentChapter(chapters, 19_999)?.id).toBe("a");
    expect(selectCurrentChapter(chapters, 20_000)?.id).toBe("b");
  });

  it("keeps the final chapter for the sliver past its end", () => {
    expect(selectCurrentChapter(chapters, 60_000)?.id).toBe("c");
    expect(selectCurrentChapter(chapters, 60_029)?.id).toBe("c");
  });

  it("returns null before any chapter or with no chapters", () => {
    expect(selectCurrentChapter([], 5_000)).toBeNull();
    expect(selectCurrentChapter([{ ...chapters[1]! }], 1_000)).toBeNull();
  });
});

describe("rewindForAbsence", () => {
  it("scales with time away and handles junk", () => {
    expect(rewindForAbsence(30_000)).toBe(0);
    expect(rewindForAbsence(5 * 60_000)).toBe(5_000);
    expect(rewindForAbsence(30 * 60_000)).toBe(15_000);
    expect(rewindForAbsence(24 * 3_600_000)).toBe(30_000);
    expect(rewindForAbsence(Number.NaN)).toBe(0);
  });
});

describe("resolveStartPosition", () => {
  it("restarts a book stored at its very end", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 60_000,
        durationMs: 60_056,
        smartRewindEnabled: true,
        msSinceLastPause: 3_600_000,
      }),
    ).toEqual({ startAtMs: 0, appliedRewindMs: 0 });
  });

  it("applies bounded smart rewind mid-book", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: 5 * 60_000,
      }),
    ).toEqual({ startAtMs: 25_000, appliedRewindMs: 5_000 });
  });

  it("skips rewind when disabled or unprimed and never goes negative", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: false,
        msSinceLastPause: 3_600_000,
      }).startAtMs,
    ).toBe(30_000);
    expect(
      resolveStartPosition({
        storedPositionMs: 30_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: null,
      }).startAtMs,
    ).toBe(30_000);
    expect(
      resolveStartPosition({
        storedPositionMs: 2_000,
        durationMs: 60_000,
        smartRewindEnabled: true,
        msSinceLastPause: 5 * 60_000,
      }).startAtMs,
    ).toBe(0);
  });
});

describe("isChapterEnding", () => {
  it("fires only inside the epsilon window", () => {
    expect(isChapterEnding(chapters[0]!, 19_700)).toBe(true);
    expect(isChapterEnding(chapters[0]!, 19_000)).toBe(false);
  });
});

describe("local playback state", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
  });

  it("round-trips positions per user and rejects junk", () => {
    saveLocalPosition("user-a", "book-1", 1234.6, 2_000);
    expect(readLocalPosition("user-a", "book-1")).toBe(1235);
    expect(readLocalPosition("user-b", "book-1")).toBeNull();
    localStorage.setItem("chapterline:position:user-a:book-1", "not-a-number");
    expect(readLocalPosition("user-a", "book-1")).toBeNull();
  });

  it("uses the freshest timestamped position and treats legacy local values as oldest", () => {
    expect(
      freshestPosition({
        local: { positionMs: 1_000, occurredAt: 2_000 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(8_000);
    expect(
      freshestPosition({
        local: { positionMs: 9_000, occurredAt: 4_000 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(9_000);
    localStorage.setItem("chapterline:position:user-a:book-1", "7000");
    expect(
      freshestPosition({
        local: { positionMs: readLocalPosition("user-a", "book-1")!, occurredAt: 0 },
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
    ).toBe(8_000);
  });
});
