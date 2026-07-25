import { describe, expect, it } from "vitest";

import { isPullBatch, type PullBatch } from "@/lib/offline/sync-protocol";

import { planTombstoneWindow } from "./tombstone-window";

const WATERMARK = "2026-07-05T00:00:00.000000Z";
const SINCE = "2026-07-01T00:00:00.000000Z";

describe("planTombstoneWindow", () => {
  it("reports nothing on a first, full sync", () => {
    expect(planTombstoneWindow(null, { complete: true, watermark: WATERMARK })).toStrictEqual({
      emit: false,
    });
  });

  it("reports every deletion after the cursor on the final page", () => {
    expect(planTombstoneWindow(SINCE, { complete: true, watermark: WATERMARK })).toStrictEqual({
      emit: true,
      floor: SINCE,
      ceiling: null,
      advancesCursor: true,
    });
  });

  it("clamps to the page watermark while book pages remain", () => {
    // A deletion stamped after the watermark must wait: reporting it would let
    // the cursor move past book rows this batch never sent, and those books
    // would then never be pulled again.
    expect(planTombstoneWindow(SINCE, { complete: false, watermark: WATERMARK })).toStrictEqual({
      emit: true,
      floor: SINCE,
      ceiling: WATERMARK,
      advancesCursor: false,
    });
  });
});

function batch(overrides: Partial<PullBatch> = {}): PullBatch {
  return {
    since: null,
    cursor: WATERMARK,
    complete: true,
    books: [],
    playbackStates: [],
    tags: [],
    collections: [],
    preferences: null,
    listeningSessions: [],
    liveBookIds: null,
    ...overrides,
  };
}

describe("tombstones on the wire", () => {
  it("accepts a batch carrying per-row tombstones", () => {
    expect(
      isPullBatch(
        batch({ tombstones: [{ bookId: "book-1", deletedAt: "2026-07-02T00:00:00.000000Z" }] }),
      ),
    ).toBe(true);
  });

  it("accepts a batch from a build that predates tombstones", () => {
    expect(isPullBatch(batch())).toBe(true);
  });

  it("rejects a malformed tombstone rather than silently dropping a deletion", () => {
    expect(isPullBatch(batch({ tombstones: [{ bookId: "book-1" }] as never }))).toBe(false);
    expect(isPullBatch(batch({ tombstones: "all of them" as never }))).toBe(false);
  });
});
