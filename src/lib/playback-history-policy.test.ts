import { describe, expect, it } from "vitest";

import {
  isReasonablePlaybackActionTime,
  MAX_PLAYBACK_ACTION_CLOCK_LEAD_MS,
} from "./playback-history-policy";

describe("playback action timestamps", () => {
  it("accepts delayed offline actions and modest device-clock lead", () => {
    const now = Date.UTC(2026, 6, 12);
    expect(isReasonablePlaybackActionTime(new Date(now - 30 * 24 * 60 * 60_000), now)).toBe(true);
    expect(
      isReasonablePlaybackActionTime(new Date(now + MAX_PLAYBACK_ACTION_CLOCK_LEAD_MS), now),
    ).toBe(true);
  });

  it("rejects timestamps far enough ahead to poison retention ordering", () => {
    const now = Date.UTC(2026, 6, 12);
    expect(
      isReasonablePlaybackActionTime(new Date(now + MAX_PLAYBACK_ACTION_CLOCK_LEAD_MS + 1), now),
    ).toBe(false);
  });
});
