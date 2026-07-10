import { describe, expect, it } from "vitest";

import { validateUploadMetadata } from "./filename";

describe("validateUploadMetadata", () => {
  it("accepts encoded MP3 filenames and strips client paths", () => {
    expect(validateUploadMetadata("folder%2FMy%20Book.MP3", "audio/mpeg")).toBe("My Book.MP3");
  });

  it.each([
    ["book.m4b", "audio/mp4"],
    ["book.mp3", "text/plain"],
    ["book.pdf", "application/pdf"],
    ["..", "audio/mpeg"],
  ])("rejects unsupported metadata for %s", (filename, mimeType) => {
    expect(() => validateUploadMetadata(filename, mimeType)).toThrow();
  });
});
