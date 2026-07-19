import { describe, expect, it } from "vitest";

import { activeCueIndex } from "./transcript-cues";

const cues = [0, 1000, 2500, 2500, 4000].map((startMs) => ({ startMs }));

describe("activeCueIndex", () => {
  it("returns -1 before the first cue and on empty lists", () => {
    expect(activeCueIndex([], 500)).toBe(-1);
    expect(activeCueIndex([{ startMs: 100 }], 99)).toBe(-1);
  });

  it("finds exact starts, mid-cue positions, and the tail", () => {
    expect(activeCueIndex(cues, 0)).toBe(0);
    expect(activeCueIndex(cues, 999)).toBe(0);
    expect(activeCueIndex(cues, 1000)).toBe(1);
    expect(activeCueIndex(cues, 3999)).toBe(3);
    expect(activeCueIndex(cues, 4000)).toBe(4);
    expect(activeCueIndex(cues, 1_000_000)).toBe(4);
  });

  it("picks the last of duplicate start times", () => {
    expect(activeCueIndex(cues, 2500)).toBe(3);
    expect(activeCueIndex(cues, 3000)).toBe(3);
  });

  it("keeps a cue active through the gap before its successor", () => {
    // Sentence ends at 1800 but the next starts at 2500: stay on it.
    expect(activeCueIndex(cues, 2200)).toBe(1);
  });

  it("stays O(log n) correct across a large chapter-sized list", () => {
    const large = Array.from({ length: 40 * 60 * 3 }, (_, index) => ({ startMs: index * 333 }));
    expect(activeCueIndex(large, 0)).toBe(0);
    expect(activeCueIndex(large, large[large.length - 1]!.startMs)).toBe(large.length - 1);
    expect(activeCueIndex(large, 1_000_000)).toBe(Math.floor(1_000_000 / 333));
  });
});
