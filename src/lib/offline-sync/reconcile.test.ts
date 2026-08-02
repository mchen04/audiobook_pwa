import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

// Deliberately does NOT import "@/lib/offline/library": these tests exercise
// the window before that module's init registers the conflict handler, which
// is exactly the state a page whose bundle omits the library layer runs in.
import {
  listQueuedMutations,
  queueProgress,
  registerProgressConflictHandler,
  replayQueuedMutations,
  type QueuedProgress,
} from "../offline-sync";

const USER = "reconcile-user";

function progressEntry(overrides: Partial<QueuedProgress> = {}): QueuedProgress {
  return {
    userId: USER,
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

function conflict409() {
  return new Response(
    JSON.stringify({
      state: {
        positionMs: 9_000,
        completed: false,
        playbackRate: 1,
        eventOccurredAt: "2026-07-09T01:00:00.000Z",
      },
    }),
    { status: 409 },
  );
}

describe("progress 409 with no registered conflict handler", () => {
  it("retains the row until a handler can project the server's state, then settles", async () => {
    await queueProgress(progressEntry());
    const fetchFn = vi.fn().mockImplementation(async () => conflict409());

    // No handler registered: the server's answer cannot be projected onto
    // local state yet, so settling would erase the only record of the
    // conflict. The row must survive the drain.
    await replayQueuedMutations(USER, fetchFn as typeof fetch);
    expect(await listQueuedMutations(USER)).toHaveLength(1);

    // Vitest gives each test file its own module registry, so registering
    // here cannot leak into other suites.
    const handler = vi.fn().mockResolvedValue(undefined);
    registerProgressConflictHandler(handler);
    await replayQueuedMutations(USER, fetchFn as typeof fetch);

    expect(handler).toHaveBeenCalledWith(USER, "book-1", {
      positionMs: 9_000,
      completed: false,
      playbackRate: 1,
      eventOccurredAt: "2026-07-09T01:00:00.000Z",
    });
    expect(await listQueuedMutations(USER)).toHaveLength(0);
  });
});
