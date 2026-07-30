import { describe, expect, it } from "vitest";

import { materializeRandomSyncSeeds, resolveSyncSeeds } from "./seeds";

describe("sync fuzz seed configuration", () => {
  it.each(["", "garbage", "1,garbage", "0", "-1", "1,", "9007199254740992"])(
    "rejects an invalid explicit seed list: %j",
    (seed) => {
      expect(() => resolveSyncSeeds({ HARK_SYNC_SEED: seed })).toThrow(/HARK_SYNC_SEED/);
    },
  );

  it("resolves every valid explicit seed", () => {
    expect(resolveSyncSeeds({ HARK_SYNC_SEED: "17, 29,41" })).toEqual([17, 29, 41]);
  });

  it("materializes random discovery into a non-empty explicit list", () => {
    const env = {
      HARK_SYNC_SEED_BASE: "random",
      HARK_SYNC_SEEDS: "3",
    };
    materializeRandomSyncSeeds(env);
    expect(resolveSyncSeeds(env)).toHaveLength(3);
  });

  it("does not replace an explicitly empty seed list with random seeds", () => {
    const env = {
      HARK_SYNC_SEED: "",
      HARK_SYNC_SEED_BASE: "random",
    };
    materializeRandomSyncSeeds(env);
    expect(() => resolveSyncSeeds(env)).toThrow(/HARK_SYNC_SEED/);
  });
});
