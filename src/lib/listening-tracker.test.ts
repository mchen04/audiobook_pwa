import { describe, expect, it, vi } from "vitest";

import { createListeningTracker } from "./listening-tracker";

function trackerWithClock(startMs: number) {
  let currentTime = startMs;
  const post = vi.fn();
  const tracker = createListeningTracker(
    post,
    () => currentTime,
    () => true,
  );
  return { tracker, post, advance: (ms: number) => (currentTime += ms) };
}

describe("createListeningTracker", () => {
  it("posts one session per contiguous listen", () => {
    const { tracker, post, advance } = trackerWithClock(1_000_000);
    tracker.begin(10_000);
    advance(30_000);
    tracker.end("book-1", 40_000);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("book-1", {
      startedAt: new Date(1_000_000).toISOString(),
      endedAt: new Date(1_030_000).toISOString(),
      startPositionMs: 10_000,
      endPositionMs: 40_000,
    });
  });

  it("ignores stretches under five seconds and double-ends", () => {
    const { tracker, post, advance } = trackerWithClock(0);
    tracker.begin(0);
    advance(3_000);
    tracker.end("book-1", 3_000);
    tracker.end("book-1", 3_000);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps the first begin of overlapping plays and can be reset", () => {
    const { tracker, post, advance } = trackerWithClock(0);
    tracker.begin(0);
    advance(2_000);
    tracker.begin(2_000);
    advance(10_000);
    tracker.end("book-1", 12_000);
    expect(post).toHaveBeenCalledWith("book-1", expect.objectContaining({ startPositionMs: 0 }));

    tracker.begin(0);
    tracker.reset();
    advance(60_000);
    tracker.end("book-1", 60_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("drops offline stretches", () => {
    const post = vi.fn();
    let t = 0;
    const tracker = createListeningTracker(
      post,
      () => (t += 10_000),
      () => false,
    );
    tracker.begin(0);
    tracker.end("book-1", 10_000);
    expect(post).not.toHaveBeenCalled();
  });
});
