import { describe, expect, it } from "vitest";

import { planBookPage } from "./page-plan";

const FLOOR = "1970-01-01T00:00:00.000000Z";

/** Microsecond-precision UTC text, exactly as the pull query formats it. */
function at(micros: number) {
  return `2026-07-24T06:18:47.${String(micros).padStart(6, "0")}Z`;
}

describe("planBookPage", () => {
  it("takes everything when the stream fits inside one page", () => {
    expect(planBookPage([at(1), at(2), at(3)], FLOOR, 200)).toStrictEqual({
      kind: "final",
      take: 3,
      watermark: at(3),
    });
  });

  it("reports the floor as the watermark when nothing changed", () => {
    expect(planBookPage([], FLOOR, 200)).toStrictEqual({
      kind: "final",
      take: 0,
      watermark: FLOOR,
    });
  });

  it("cuts a full page below the first timestamp it cannot finish", () => {
    const cursors = [at(1), at(2), at(3), at(3)];
    expect(planBookPage(cursors, FLOOR, 3)).toStrictEqual({
      kind: "partial",
      take: 2,
      watermark: at(2),
    });
  });

  it("asks for the whole group when one timestamp fills the page", () => {
    expect(planBookPage([at(5), at(5), at(5), at(5)], FLOOR, 3)).toStrictEqual({
      kind: "bucket",
      boundary: at(5),
    });
  });

  it("never leaves a watermark that a skipped row could re-satisfy", () => {
    // The regression: a watermark equal to a row that was not carried makes
    // `updatedAt > watermark` re-select it, and the pull never terminates.
    const cursors = [at(1), at(1), at(2), at(2), at(2)];
    const plan = planBookPage(cursors, FLOOR, 4);
    expect(plan.kind).toBe("partial");
    if (plan.kind !== "partial") return;
    const taken = cursors.slice(0, plan.take);
    const skipped = cursors.slice(plan.take);
    expect(taken.every((cursor) => cursor <= plan.watermark)).toBe(true);
    expect(skipped.every((cursor) => cursor > plan.watermark)).toBe(true);
  });

  it("keeps millisecond-identical rows apart by their microseconds", () => {
    // Truncating these to milliseconds collapses them to one value, which is
    // exactly how a Date-based cursor stalls.
    const cursors = [at(123_000), at(123_400), at(123_800), at(999_000)];
    const plan = planBookPage(cursors, FLOOR, 3);
    expect(plan).toStrictEqual({ kind: "partial", take: 3, watermark: at(123_800) });
  });
});
