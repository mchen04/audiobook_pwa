import { describe, expect, it } from "vitest";

import { hasEnoughCapacity } from "./media-store";

describe("offline storage capacity", () => {
  it("allows unknown quotas and unknown file sizes", () => {
    expect(hasEnoughCapacity({}, 10_000)).toBe(true);
    expect(hasEnoughCapacity({ quota: 1_000, usage: 999 }, 0)).toBe(true);
  });

  it("reserves headroom instead of filling the device quota", () => {
    expect(hasEnoughCapacity({ quota: 1_000, usage: 100 }, 800)).toBe(true);
    expect(hasEnoughCapacity({ quota: 1_000, usage: 100 }, 850)).toBe(false);
  });
});
