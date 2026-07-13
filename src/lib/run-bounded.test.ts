import { describe, expect, it, vi } from "vitest";

import { runBounded } from "./run-bounded";

describe("runBounded", () => {
  it("processes falsy values", async () => {
    const seen: Array<number | boolean | null> = [];
    await runBounded([0, false, null, 2], 2, async (value) => {
      seen.push(value);
    });
    expect(seen).toHaveLength(4);
    expect(seen).toEqual(expect.arrayContaining([0, false, null, 2]));
  });

  it("rejects invalid concurrency", async () => {
    const worker = vi.fn();
    await expect(runBounded([1], 0, worker)).rejects.toThrow(RangeError);
    expect(worker).not.toHaveBeenCalled();
  });
});
