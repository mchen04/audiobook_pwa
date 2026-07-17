import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The service worker implements range parsing in plain JS because it cannot
// import TypeScript modules; these golden vectors pin its semantics.
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const parseRangeSource = source.match(/function parseRange\([\s\S]*?\n\}/)?.[0];
if (!parseRangeSource) throw new Error("public/sw.js no longer defines parseRange");
const parseRange = new Function(`${parseRangeSource}; return parseRange;`)() as (
  header: string,
  totalSize: number,
) => { start: number; end: number } | null;

describe("service-worker range parsing", () => {
  it("parses closed and open-ended ranges", () => {
    expect(parseRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-", 1_000)).toEqual({ start: 0, end: 999 });
    expect(parseRange(" bytes=100-200 ", 1_000)).toEqual({ start: 100, end: 200 });
  });

  it("parses suffix ranges and clamps them to the file size", () => {
    expect(parseRange("bytes=-75", 1_000)).toEqual({ start: 925, end: 999 });
    expect(parseRange("bytes=-2000", 1_000)).toEqual({ start: 0, end: 999 });
  });

  it("clamps a closed range end to the file size", () => {
    expect(parseRange("bytes=950-5000", 1_000)).toEqual({ start: 950, end: 999 });
  });

  it.each([
    "bytes=",
    "bytes=9-2",
    "bytes=1000-",
    "bytes=999999-",
    "bytes=-0",
    "bytes=-",
    "items=0-4",
    "bytes=0-1,4-5",
    "bytes=abc-def",
  ])("rejects an invalid or unsatisfiable range: %s", (value) => {
    expect(parseRange(value, 1_000)).toBeNull();
  });

  it("rejects any range for a zero-size object", () => {
    expect(parseRange("bytes=0-10", 0)).toBeNull();
  });
});
