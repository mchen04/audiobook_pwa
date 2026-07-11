import { describe, expect, it } from "vitest";

import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  InvalidLibraryCursorError,
} from "./library-cursor";

describe("library cursors", () => {
  it("round-trips a versioned cursor only for its originating sort", () => {
    const cursor = encodeLibraryCursor({
      version: 1,
      sort: "title",
      value: "chapterline",
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(decodeLibraryCursor(cursor, "title")).toMatchObject({ value: "chapterline" });
    expect(() => decodeLibraryCursor(cursor, "added")).toThrow(InvalidLibraryCursorError);
  });

  it("rejects malformed UUIDs and timestamps before they reach PostgreSQL", () => {
    const malformed = Buffer.from(
      JSON.stringify({ version: 1, sort: "added", value: "not-a-date", id: "not-a-uuid" }),
    ).toString("base64url");
    expect(() => decodeLibraryCursor(malformed, "added")).toThrow(InvalidLibraryCursorError);
  });
});
