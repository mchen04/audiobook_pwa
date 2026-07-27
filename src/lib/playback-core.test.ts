import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerChapter } from "@/domain/player";

import {
  freshestPosition,
  isChapterEnding,
  localWinsOver,
  readLatestLocalPlayback,
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

/**
 * Provenance on the durable record — the two fields that let a person settle
 * `docs/resume-durability-device-check.md` by reading the app instead of
 * inferring from a resumed position.
 */
describe("durable write provenance", () => {
  const KEY = "chapterline:position:user-a:book-1";

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the mechanism that wrote the record", () => {
    saveLocalPlaybackState("user-a", "book-1", { positionMs: 1_000, source: "cadence-timer" });
    expect(readLocalProgress("user-a", "book-1")?.source).toBe("cadence-timer");
  });

  /**
   * The readout in Settings renders this verbatim, so a value this build does
   * not write is dropped rather than shown. Absent reads as "unknown", which is
   * the truth; a stray string would read as a writer that does not exist.
   */
  it("drops a source the current build does not write", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ positionMs: 1_000, occurredAt: 5_000, source: "carrier-pigeon" }),
    );
    expect(readLocalProgress("user-a", "book-1")?.source).toBeUndefined();
    expect(readLocalProgress("user-a", "book-1")?.positionMs).toBe(1_000);
  });

  /**
   * THE X3 INVARIANT, restated now that a second timestamp exists beside it.
   *
   * `occurredAt` answers "when was this position reached" and must stay frozen
   * across a re-write that carries no new position — re-stamping it is how a
   * stale tab overrules another device's real listening. `writtenAt` answers
   * "when did something last write this record" and must move every time.
   *
   * They are pinned together here because the cheap mistake is to satisfy the
   * new field by reusing the old one, which silently reintroduces the
   * cross-device regression the frozen `occurredAt` exists to prevent.
   */
  it("advances writtenAt on a re-write while occurredAt stays where the listening was", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793, source: "pause" });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 10_000,
        writtenAt: 10_000,
      });

      // The terminal flush 15 seconds later: same position, no new listening.
      vi.setSystemTime(new Date(25_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_793, source: "pagehide-flush" });
      const afterFlush = readLocalProgress("user-a", "book-1")!;
      expect(
        afterFlush.occurredAt,
        "occurredAt moved on a write that carried no new position, which is exactly the " +
          "cross-device regression X3 measured",
      ).toBe(10_000);
      expect(
        afterFlush.writtenAt,
        "writtenAt did not move, so the record cannot say how long ago something last wrote it " +
          "— which is the whole question the device check asks",
      ).toBe(25_000);
      expect(afterFlush.source).toBe("pagehide-flush");
      // And the frozen moment still loses to a newer server record.
      expect(localWinsOver(afterFlush, new Date(20_000).toISOString())).toBe(false);

      // A write that DOES move the position moves both.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 6_794, source: "media-tick" });
      expect(readLocalProgress("user-a", "book-1")).toMatchObject({
        occurredAt: 30_000,
        writtenAt: 30_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Both fields are optional and there is no IndexedDB migration, so every
   * record written by a shipped build has to keep parsing and resuming exactly
   * as it did — including the pre-v2 bare-number form.
   */
  it("still parses and resumes a record written before provenance existed", () => {
    localStorage.setItem(KEY, JSON.stringify({ positionMs: 42_000, occurredAt: 9_000 }));
    const record = readLocalProgress("user-a", "book-1")!;
    expect(record).toStrictEqual({ positionMs: 42_000, occurredAt: 9_000 });
    expect(record.source).toBeUndefined();
    expect(record.writtenAt).toBeUndefined();
    expect(
      freshestPosition({
        local: record,
        serverPositionMs: 8_000,
        serverOccurredAt: new Date(3_000).toISOString(),
      }),
      "a record with no provenance stopped winning against an older server position",
    ).toBe(42_000);

    localStorage.setItem("chapterline:position:user-a:book-2", "7000");
    expect(readLocalProgress("user-a", "book-2")).toStrictEqual({
      positionMs: 7_000,
      occurredAt: 0,
    });
  });

  /**
   * The settings readout names ONE book, so it has to be the one written last.
   * Ordering by `occurredAt` would name the wrong one, because that field is
   * deliberately frozen on re-writes.
   */
  it("finds the most recently written book, not the most recently reached position", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(10_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 500, source: "seek" });
      vi.setSystemTime(new Date(20_000));
      saveLocalPlaybackState("user-a", "book-2", { positionMs: 900, source: "media-tick" });
      // book-1 is re-written last but at a position it already held, so its
      // `occurredAt` stays at 10_000 while its `writtenAt` becomes the newest.
      vi.setSystemTime(new Date(30_000));
      saveLocalPlaybackState("user-a", "book-1", { positionMs: 500, source: "visibility-flush" });

      const latest = readLatestLocalPlayback("user-a");
      expect(latest?.bookId).toBe("book-1");
      expect(latest?.state).toMatchObject({
        source: "visibility-flush",
        writtenAt: 30_000,
        occurredAt: 10_000,
      });
      expect(readLatestLocalPlayback("user-b")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
