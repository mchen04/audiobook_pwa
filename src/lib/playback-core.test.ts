import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerChapter } from "@/domain/player";

import {
  freshestPosition,
  isChapterEnding,
  localWinsOver,
  readLocalPosition,
  readLocalProgress,
  resolveStartPosition,
  rewindForAbsence,
  saveLocalPlaybackState,
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

  /**
   * The unit-level statement of `tests/resume/uncovered-axes.spec.ts` X3.
   *
   * The e2e row is the one that grades the product, in WebKit, on two real
   * devices. This is the same rule expressed where it is cheap to run and
   * impossible to misread: a durable write that carries no new position must
   * not claim a newer moment, because `occurredAt` is the only thing
   * `localWinsOver` compares and a fresher stamp on an unmoved position is how
   * a stale tab overrules another device's real listening.
   */
  it("does not re-stamp a durable write that carries no new position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 6_793,
        occurredAt: 10_000,
      });

      // Another device moves the book forward while this one sits paused.
      const serverOccurredAt = new Date(20_000).toISOString();

      // The terminal flush: same position, 15 seconds later.
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      const afterFlush = readLocalProgress("user-a", "book-1")!;
      expect(afterFlush.occurredAt).toBe(10_000);
      expect(localWinsOver(afterFlush, serverOccurredAt)).toBe(false);
      expect(
        freshestPosition({
          local: afterFlush,
          serverPositionMs: 15_666,
          serverOccurredAt,
        }),
      ).toBe(15_666);

      // A write that DOES move the position still claims the new moment.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_794 });
      const afterListening = readLocalProgress("user-a", "book-1")!;
      expect(afterListening.occurredAt).toBe(30_000);
      expect(localWinsOver(afterListening, serverOccurredAt)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A record that claims no moment cannot lend one to the write that follows. */
  it("re-stamps when the stored record is a legacy value with no moment", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("chapterline:position:user-a:book-1", "6793");
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({ occurredAt: 0 });
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793 });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        positionMs: 6_793,
        occurredAt: 25_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
