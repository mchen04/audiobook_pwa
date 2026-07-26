// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";

const { commitProgress, mirrorProgress, reconcileProgressConflict, replayQueuedMutations } =
  vi.hoisted(() => ({
    commitProgress: vi.fn(),
    mirrorProgress: vi.fn(),
    reconcileProgressConflict: vi.fn(),
    replayQueuedMutations: vi.fn(),
  }));

vi.mock("@/lib/offline/outbox", () => ({ commitProgress, mirrorProgress }));
vi.mock("@/lib/offline-sync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/offline-sync")>("@/lib/offline-sync");
  return {
    ...actual,
    reconcileProgressConflict,
    replayQueuedMutations,
    nextDeviceSequence: vi.fn().mockResolvedValue(1),
    withProgressMutationLock: (_bookId: string, run: () => Promise<void>) => run(),
  };
});

import { nextDeviceSequence } from "@/lib/offline-sync";

import { useProgressPersistence } from "./use-progress-persistence";

const book: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 60_000,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 0,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};

function mountHook() {
  const audio = {
    currentTime: 12,
    playbackRate: 1,
    paused: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLAudioElement;
  const audioRef = { current: audio };
  const activeBookRef = { current: book };
  const { result } = renderHook(() => useProgressPersistence("user-a", audioRef, activeBookRef));
  // Nothing is written for a book whose position has not moved on this open;
  // these rows are about a real listening session, so say so.
  result.current.markInProgress();
  return result;
}

function respondWith(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(status === 204 ? null : "{}", { status })),
  );
}

describe("the server half of a progress write", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    commitProgress.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    reconcileProgressConflict.mockReset().mockResolvedValue(undefined);
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects an accepted write to the shelf and journals nothing", async () => {
    respondWith(200);
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(commitProgress).not.toHaveBeenCalled();
  });

  it("journals a retryable rejection and projects nothing", async () => {
    respondWith(503);
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  /**
   * F3. `shouldRetainMutation` answers "is this worth retrying", and the `else`
   * branch read it as "was this accepted". Everything it says no to that is not
   * a 2xx — 400, 404, 410, 413, 422 — was therefore mirrored into the store the
   * shelf renders from as if the server held it, with no outbox row to ever
   * correct it. A 404 is the live case: the book was deleted on another device,
   * the write is refused forever, and the card kept showing a position for it.
   */
  for (const status of [400, 404, 410, 413, 422]) {
    it(`neither projects nor journals a permanently refused write (${status})`, async () => {
      respondWith(status);
      const result = mountHook();
      await result.current.persistProgress(12_000);
      expect(
        mirrorProgress,
        `a ${status} is a refusal; mirroring it tells this device's shelf the server holds a ` +
          "position it rejected",
      ).not.toHaveBeenCalled();
      expect(
        commitProgress,
        `a ${status} will be refused again on every replay, so journalling it queues a write ` +
          "that can never drain",
      ).not.toHaveBeenCalled();
    });
  }

  it("journals a write that never reached a server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  /**
   * F3b. `mirrorProgress` used to sit inside the same `try` as the `fetch`, so
   * a storage fault was indistinguishable from a network fault: the server had
   * already accepted the event, IndexedDB failed to project it, and the catch
   * journalled an outbox row that the next replay re-sent.
   */
  it("does not journal an accepted write when the local projection is what failed", async () => {
    respondWith(200);
    mirrorProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(
      commitProgress,
      "the server accepted this write; a failure to project it locally is not an unsent intent",
    ).not.toHaveBeenCalled();
  });

  /**
   * F3b, the other half. The catch used to re-run the very call that had just
   * thrown, inside the mutation lock, and then reject anyway.
   */
  it("does not retry the outbox write that just failed", async () => {
    respondWith(503);
    commitProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
  });

  /**
   * F10. Every caller reaches this through `void persistProgress(...)`, so a
   * rejection escaping it is an unhandled rejection on the window for a case
   * the design already calls survivable.
   */
  it("never rejects, whatever the storage layer does", async () => {
    respondWith(200);
    // `nextDeviceSequence` is an IndexedDB read, and it is awaited before the
    // request is even built — outside every `catch` in this hook. On a device
    // with the database evicted it is the first thing to throw.
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await expect(result.current.persistProgress(12_000)).resolves.toBeUndefined();
  });

  it("still writes the durable local position when the server half throws", async () => {
    respondWith(200);
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await result.current.persistProgress(12_000);
    expect(JSON.parse(localStorage.getItem("chapterline:position:user-a:book-1")!)).toMatchObject({
      positionMs: 12_000,
    });
  });
});
