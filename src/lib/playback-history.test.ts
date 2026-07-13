import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

import type { PlaybackHistoryEntry } from "@/domain/player";

import {
  clearPlaybackHistoryForUser,
  loadPlaybackHistory,
  PLAYBACK_HISTORY_LIMIT,
  replayPlaybackHistory,
  storePlaybackAction,
} from "./playback-history";

const userId = "history-user";
const bookId = "history-book";

function entry(index: number): PlaybackHistoryEntry {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    action: "seek",
    positionMs: index * 1_000,
    previousPositionMs: Math.max(0, index - 1) * 1_000,
    playbackRate: 1,
    description: null,
    occurredAt: new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString(),
  };
}

beforeEach(async () => {
  await clearPlaybackHistoryForUser(userId);
});

afterEach(() => vi.unstubAllGlobals());

describe("local playback history", () => {
  it("keeps the newest 50 actions per audiobook", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    for (let index = 0; index < PLAYBACK_HISTORY_LIMIT + 5; index += 1) {
      await storePlaybackAction(userId, bookId, entry(index), offline as typeof fetch);
    }

    const history = await loadPlaybackHistory(userId, bookId);
    expect(history).toHaveLength(PLAYBACK_HISTORY_LIMIT);
    expect(history[0]?.positionMs).toBe(54_000);
    expect(history.at(-1)?.positionMs).toBe(5_000);
  });

  it("merges server history without dropping pending local actions", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    await storePlaybackAction(userId, bookId, entry(2), offline as typeof fetch);

    const history = await loadPlaybackHistory(userId, bookId, {
      entries: [entry(1)],
      capturedAt: "2026-07-12T00:00:01.500Z",
    });
    expect(history.map((item) => item.id)).toEqual([entry(2).id, entry(1).id]);

    const online = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    await replayPlaybackHistory(userId, online as typeof fetch);
    expect(online).toHaveBeenCalledOnce();
  });

  it("treats an empty server snapshot as authoritative while preserving newer local syncs", async () => {
    const online = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const action = JSON.parse(String(init?.body)) as { positionMs: number };
      return Response.json(
        {
          recordedAt:
            action.positionMs === 1_000
              ? "2026-07-12T00:00:01.000Z"
              : action.positionMs === 2_000
                ? "2026-07-12T00:00:05.000Z"
                : "2026-07-12T00:00:10.000Z",
        },
        { status: 201 },
      );
    });
    await storePlaybackAction(userId, bookId, entry(1), online as typeof fetch);
    await storePlaybackAction(userId, bookId, entry(2), online as typeof fetch);
    await storePlaybackAction(userId, bookId, entry(3), online as typeof fetch);

    const history = await loadPlaybackHistory(userId, bookId, {
      entries: [],
      capturedAt: "2026-07-12T00:00:05.000Z",
    });

    expect(history.map((item) => item.id)).toEqual([entry(3).id, entry(2).id]);
  });

  it("serializes concurrent live writes for each audiobook", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const positions: number[] = [];
    const online = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const action = JSON.parse(String(init?.body)) as { positionMs: number };
      positions.push(action.positionMs);
      if (action.positionMs === 1_000) await firstPending;
      return Response.json({ recordedAt: new Date().toISOString() }, { status: 201 });
    });

    const first = storePlaybackAction(userId, bookId, entry(1), online as typeof fetch);
    const second = storePlaybackAction(userId, bookId, entry(2), online as typeof fetch);
    await vi.waitFor(() => expect(online).toHaveBeenCalledOnce());
    expect(positions).toEqual([1_000]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(positions).toEqual([1_000, 2_000]);
  });

  it("uses a cross-tab browser lock for each audiobook sync", async () => {
    const request = vi.fn(async (_name: string, operation: () => Promise<boolean>) => operation());
    vi.stubGlobal("navigator", { locks: { request } });
    const online = vi
      .fn()
      .mockResolvedValue(Response.json({ recordedAt: new Date().toISOString() }, { status: 201 }));

    await storePlaybackAction(userId, bookId, entry(1), online as typeof fetch);

    expect(request).toHaveBeenCalledWith(
      `hark:playback-history:${userId}:${bookId}`,
      expect.any(Function),
    );
  });

  it("preserves snapshot ordering when an acknowledgement arrives during reconciliation", async () => {
    let releasePayload: (() => void) | undefined;
    let payloadRequested = false;
    const payloadPending = new Promise<void>((resolve) => {
      releasePayload = resolve;
    });
    const response = {
      ok: true,
      status: 201,
      clone: () => ({
        json: async () => {
          payloadRequested = true;
          await payloadPending;
          return { recordedAt: "2026-07-12T00:00:03.000Z" };
        },
      }),
    } as Response;
    const syncing = storePlaybackAction(
      userId,
      bookId,
      entry(1),
      vi.fn().mockResolvedValue(response) as typeof fetch,
    );
    await vi.waitFor(() => expect(payloadRequested).toBe(true));

    await loadPlaybackHistory(userId, bookId, {
      entries: [entry(101), entry(100)],
      capturedAt: "2026-07-12T00:00:02.000Z",
    });
    releasePayload?.();
    await syncing;
    await storePlaybackAction(
      userId,
      bookId,
      entry(2),
      vi.fn().mockRejectedValue(new TypeError("offline")) as typeof fetch,
    );

    const history = await loadPlaybackHistory(userId, bookId);
    expect(history.map((item) => item.id)).toEqual([
      entry(2).id,
      entry(1).id,
      entry(101).id,
      entry(100).id,
    ]);
  });

  it("uses insertion order for retention even when a device clock jumps forward", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    const poisoned = {
      ...entry(0),
      occurredAt: "2099-01-01T00:00:00.000Z",
      recordedAt: "2099-01-01T00:00:00.000Z",
    };
    await storePlaybackAction(userId, bookId, poisoned, offline as typeof fetch);
    for (let index = 1; index <= PLAYBACK_HISTORY_LIMIT; index += 1) {
      await storePlaybackAction(userId, bookId, entry(index), offline as typeof fetch);
    }

    const history = await loadPlaybackHistory(userId, bookId);
    expect(history).toHaveLength(PLAYBACK_HISTORY_LIMIT);
    expect(history.some((item) => item.id === poisoned.id)).toBe(false);
  });

  it("replays large accounts in pages with at most four requests in flight", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    for (let index = 0; index < 120; index += 1) {
      await storePlaybackAction(
        userId,
        `book-${Math.floor(index / 40)}`,
        entry(index),
        offline as typeof fetch,
      );
    }
    let active = 0;
    let maxActive = 0;
    const online = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new Response(null, { status: 201 });
    });

    await replayPlaybackHistory(userId, online as typeof fetch);

    expect(online).toHaveBeenCalledTimes(120);
    expect(maxActive).toBeLessThanOrEqual(4);
    for (let book = 0; book < 3; book += 1) {
      const positions = online.mock.calls
        .filter(([url]) => String(url).includes(`/book-${book}/`))
        .map(([, init]) => JSON.parse(init?.body as string).positionMs);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it("removes actions rejected by the server instead of treating them as synced", async () => {
    const rejected = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

    await expect(
      storePlaybackAction(userId, bookId, entry(1), rejected as typeof fetch),
    ).resolves.toBe("rejected");
    await expect(loadPlaybackHistory(userId, bookId)).resolves.toEqual([]);
  });

  it("coalesces concurrent reconnect triggers for one user", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
    await storePlaybackAction(userId, bookId, entry(1), offline as typeof fetch);
    let resolveRequest: ((response: Response) => void) | undefined;
    const online = vi.fn(() => new Promise<Response>((resolve) => void (resolveRequest = resolve)));

    const first = replayPlaybackHistory(userId, online as typeof fetch);
    const second = replayPlaybackHistory(userId, online as typeof fetch);
    await vi.waitFor(() => expect(online).toHaveBeenCalledOnce());
    resolveRequest?.(new Response(null, { status: 201 }));
    await Promise.all([first, second]);

    expect(online).toHaveBeenCalledOnce();
  });
});
