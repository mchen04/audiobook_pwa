import { describe, expect, it } from "vitest";

import { formatClock, formatDurationRounded } from "./format-time";

describe("formatClock", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(59_999)).toBe("0:59");
  });

  it("adds an hours part past sixty minutes", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("clamps negatives to zero", () => {
    expect(formatClock(-500)).toBe("0:00");
  });
});

describe("formatDurationRounded", () => {
  it("never shows less than a minute", () => {
    expect(formatDurationRounded(0)).toBe("1m");
    expect(formatDurationRounded(20_000)).toBe("1m");
  });

  it("rounds to minutes and splits hours", () => {
    expect(formatDurationRounded(45 * 60_000)).toBe("45m");
    expect(formatDurationRounded(6 * 3_600_000 + 12 * 60_000)).toBe("6h 12m");
  });
});
