import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseByteRange, UnsatisfiableRangeError } from "./range";

/**
 * The service worker re-implements range parsing for cached offline media
 * because it cannot import TypeScript modules. This suite holds the two
 * implementations to identical semantics so they cannot silently diverge.
 */
const swSource = readFileSync(path.resolve(__dirname, "../../../public/sw.js"), "utf8");
const parseRangeMatch = swSource.match(/function parseRange\([\s\S]*?\n\}/);
if (!parseRangeMatch) throw new Error("public/sw.js no longer defines parseRange");
const swParseRange = new Function(`${parseRangeMatch[0]}; return parseRange;`)() as (
  header: string,
  totalSize: number,
) => { start: number; end: number } | null;

function serverResult(header: string, size: number): { start: number; end: number } | null {
  try {
    const range = parseByteRange(header, size);
    return range ? { start: range.start, end: range.end } : null;
  } catch (error) {
    if (error instanceof UnsatisfiableRangeError) return null;
    throw error;
  }
}

const SIZE = 10_000;

describe("range parser parity (server vs service worker)", () => {
  const vectors = [
    "bytes=0-99",
    "bytes=0-",
    "bytes=9999-",
    "bytes=5000-4000",
    "bytes=10000-",
    "bytes=999999-",
    "bytes=-500",
    "bytes=-10001",
    "bytes=-0",
    "bytes=-",
    "bytes=abc-def",
    "bytes=0-99999999",
    " bytes=100-200 ",
  ];

  for (const header of vectors) {
    it(`agrees on ${JSON.stringify(header)}`, () => {
      expect(swParseRange(header, SIZE)).toEqual(serverResult(header, SIZE));
    });
  }

  it("agrees on a zero-size object", () => {
    expect(swParseRange("bytes=0-10", 0)).toEqual(serverResult("bytes=0-10", 0));
  });
});
