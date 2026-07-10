import { describe, expect, it } from "vitest";

import { parseByteRange, UnsatisfiableRangeError } from "./range";

describe("parseByteRange", () => {
  it("returns null when a client requests the complete file", () => {
    expect(parseByteRange(null, 1_000)).toBeNull();
  });

  it("parses closed and open-ended ranges", () => {
    expect(parseByteRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199, length: 100 });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it("parses suffix ranges and clamps them to the file size", () => {
    expect(parseByteRange("bytes=-75", 1_000)).toEqual({ start: 925, end: 999, length: 75 });
    expect(parseByteRange("bytes=-2000", 1_000)).toEqual({ start: 0, end: 999, length: 1_000 });
  });

  it("clamps a closed range end to the file size", () => {
    expect(parseByteRange("bytes=950-5000", 1_000)).toEqual({ start: 950, end: 999, length: 50 });
  });

  it.each(["bytes=", "bytes=9-2", "bytes=1000-", "items=0-4", "bytes=0-1,4-5"])(
    "rejects an invalid or unsupported range: %s",
    (value) => {
      expect(() => parseByteRange(value, 1_000)).toThrow(UnsatisfiableRangeError);
    },
  );
});
