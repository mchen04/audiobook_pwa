import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import {
  clearQueuedMutationsForUser,
  nextDeviceSequence,
  queueProgress,
  replayQueuedMutations,
  type QueuedProgress,
} from "./offline-sync";

function progressEntry(overrides: Partial<QueuedProgress> = {}): QueuedProgress {
  return {
    userId: "user-a",
    bookId: "book-1",
    deviceId: "device-1",
    deviceSequence: 1,
    positionMs: 5_000,
    playbackRate: 1.5,
    completed: false,
    eventOccurredAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  await clearQueuedMutationsForUser("user-a");
  await clearQueuedMutationsForUser("user-b");
});

describe("offline progress queue", () => {
  it("replays queued progress once the network answers", async () => {
    await queueProgress(progressEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/api/books/book-1/progress");
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).deviceSequence).toBe(1);
  });

  it("keeps transient failures queued until a later success", async () => {
    await queueProgress(progressEntry());
    const unavailable = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    expect(unavailable).toHaveBeenCalledTimes(2);

    const succeeding = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    expect(succeeding).toHaveBeenCalledOnce();
  });

  it("compacts progress to the newest device sequence", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1, positionMs: 1_000 }));
    await queueProgress(progressEntry({ deviceSequence: 3, positionMs: 3_000 }));
    await queueProgress(progressEntry({ deviceSequence: 2, positionMs: 2_000 }));
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).deviceSequence).toBe(3);
  });

  it("does not erase progress queued while replay is in flight", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1 }));
    const fetchFn = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      await queueProgress(progressEntry({ deviceSequence: 2 }));
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body as string).deviceSequence).toBe(2);
  });

  it("allocates device sequences transactionally", async () => {
    await expect(
      Promise.all([nextDeviceSequence("sequence-book"), nextDeviceSequence("sequence-book")]),
    ).resolves.toEqual(expect.arrayContaining([1, 2]));
  });

  it("replays large progress queues with bounded concurrency", async () => {
    for (let index = 0; index < 120; index += 1) {
      await queueProgress(
        progressEntry({
          bookId: `book-${String(index).padStart(3, "0")}`,
          deviceId: `device-${String(index).padStart(3, "0")}`,
        }),
      );
    }
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(120);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});
