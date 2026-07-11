import { describe, expect, it } from "vitest";

import { isValidListeningSession } from "./listening-session-policy";

const now = new Date("2026-07-10T12:00:00.000Z");
const valid = {
  startedAt: new Date("2026-07-10T11:59:30.000Z"),
  endedAt: new Date("2026-07-10T11:59:45.000Z"),
  startPositionMs: 1_000,
  endPositionMs: 16_000,
  durationMs: 60_000,
  now,
};

describe("listening session policy", () => {
  it("accepts a bounded session", () => {
    expect(isValidListeningSession(valid)).toBe(true);
  });

  it("rejects unsafe, out-of-book, reversed, and future values", () => {
    expect(isValidListeningSession({ ...valid, endPositionMs: Number.MAX_VALUE })).toBe(false);
    expect(isValidListeningSession({ ...valid, endPositionMs: 60_001 })).toBe(false);
    expect(isValidListeningSession({ ...valid, endedAt: valid.startedAt })).toBe(false);
    expect(
      isValidListeningSession({
        ...valid,
        endedAt: new Date("2026-07-10T12:06:00.000Z"),
      }),
    ).toBe(false);
  });
});
