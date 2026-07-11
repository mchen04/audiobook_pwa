import { describe, expect, it } from "vitest";

import { CHAPTER_WINDOW_SIZE, chapterWindow, chapterWindowStart } from "./chapter-window";

describe("chapter presentation window", () => {
  it("bounds a valid 10,000 chapter book while keeping the active chapter visible", () => {
    const chapters = Array.from({ length: 10_000 }, (_, index) => index);
    const start = chapterWindowStart(9_500, chapters.length);
    const visible = chapterWindow(chapters, start);

    expect(visible).toHaveLength(CHAPTER_WINDOW_SIZE);
    expect(visible).toContain(9_500);
    expect(start).toBeLessThanOrEqual(9_500);
  });

  it("does not window ordinary chapter lists", () => {
    expect(chapterWindowStart(3, 12)).toBe(0);
    expect(chapterWindow([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });
});
