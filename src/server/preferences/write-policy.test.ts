import { describe, expect, it } from "vitest";

import { PREFERENCES_DEFAULTS_VERSION } from "@/lib/preferences";

import {
  applyPreferenceWritePolicy,
  resolveSmartRewind,
  serializePlayerPreferences,
} from "./write-policy";

describe("preference rollout policy", () => {
  it("leaves unversioned transition policy to the database invariant", () => {
    expect(
      applyPreferenceWritePolicy(
        {
          skipBackMs: 45_000,
          smartRewind: true,
        },
        null,
      ),
    ).toEqual({
      patch: {
        skipBackMs: 45_000,
        smartRewind: true,
      },
    });
  });

  it("allows a current client to opt into smart rewind explicitly", () => {
    expect(
      applyPreferenceWritePolicy(
        {
          smartRewind: true,
        },
        String(PREFERENCES_DEFAULTS_VERSION),
      ),
    ).toEqual({
      patch: { smartRewind: true },
      smartRewindExplicit: true,
    });
  });

  it("marks a current opt-out as unable to authorize a later legacy true", () => {
    expect(
      applyPreferenceWritePolicy(
        {
          smartRewind: false,
        },
        String(PREFERENCES_DEFAULTS_VERSION),
      ),
    ).toEqual({
      patch: { smartRewind: false },
      smartRewindExplicit: false,
    });
  });

  it("masks a true value written by an old instance after the migration", () => {
    expect(
      resolveSmartRewind({
        smartRewind: true,
        smartRewindExplicit: false,
      }),
    ).toBe(false);
  });

  it("returns true only after a provenance-backed current-client opt-in", () => {
    expect(
      resolveSmartRewind({
        smartRewind: true,
        smartRewindExplicit: true,
      }),
    ).toBe(true);
  });

  it("uses the masked value when serializing preferences", () => {
    expect(
      serializePlayerPreferences({
        skipBackMs: 15_000,
        skipForwardMs: 30_000,
        smartRewind: true,
        smartRewindExplicit: false,
        autoplayNextInCollection: false,
      }),
    ).toEqual({
      skipBackMs: 15_000,
      skipForwardMs: 30_000,
      smartRewind: false,
      autoplayNextInCollection: false,
    });
  });
});
