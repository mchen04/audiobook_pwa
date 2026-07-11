import { describe, expect, it, vi } from "vitest";

import { fingerprintMedia } from "./media-fingerprint";

describe("media fingerprints", () => {
  it("streams an exact SHA-256 over the complete file", async () => {
    const bytes = Uint8Array.from({ length: 5 * 1024 * 1024 + 17 }, (_, index) => index % 251);
    const file = new File([bytes], "book.mp3");
    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const progress = vi.fn();

    await expect(fingerprintMedia(file, "sha256-v1", progress)).resolves.toBe(expected);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it("retains the legacy sample algorithm for existing registrations", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "legacy.mp3");

    expect(await fingerprintMedia(file, "sample-v1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
