import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PREFERENCES,
  fetchPreferences,
  listPendingPreferenceWrites,
  readCachedPreferences,
  savePreferences,
} from "./preferences";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage);
  vi.restoreAllMocks();
});

/** Enough of `window` for the reconnect listener, with a way to fire "online". */
function fakeWindow() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set<EventListener>();
      listeners.set(type, set);
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(new Event(type));
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("preference durability", () => {
  it("keeps a failed write pending and replays it before accepting server state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ preferences: { ...DEFAULT_PREFERENCES, smartRewind: false } }),
      )
      .mockResolvedValueOnce(Response.json({ preferences: DEFAULT_PREFERENCES }));
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences("user-a", DEFAULT_PREFERENCES, { smartRewind: false });
    expect(readCachedPreferences("user-a").smartRewind).toBe(false);

    await expect(fetchPreferences("user-a")).resolves.toMatchObject({ smartRewind: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ smartRewind: false });
  });

  it("serializes rapid writes and leaves the newest value cached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = savePreferences("user-a", DEFAULT_PREFERENCES, { skipBackMs: 10_000 });
    const second = savePreferences(
      "user-a",
      { ...DEFAULT_PREFERENCES, skipBackMs: 10_000 },
      { skipBackMs: 45_000 },
    );
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCachedPreferences("user-a").skipBackMs).toBe(45_000);
  });
});

/**
 * A preference change is the one user write in this product that is NOT an
 * outbox row (`docs/local-first.md` section 5) — it lives only as a flag in
 * `chapterline:preferences:<userId>`, a key `clearLocalDataForUser` removes
 * wholesale on sign-out. So the two things below are the entire safety net:
 * the write must heal itself on reconnect, and while it has not, it must be
 * visible to the sign-out drain that is about to delete it.
 */
describe("an undelivered preference change is not lost silently", () => {
  it("retries the dropped write when the device comes back online", async () => {
    const userId = "user-reconnect";
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences(userId, DEFAULT_PREFERENCES, { skipForwardMs: 45_000 });
    expect(
      listPendingPreferenceWrites(userId),
      "a PATCH that never landed left nothing outstanding",
    ).toHaveLength(1);

    win.emit("online");
    await vi.waitFor(() =>
      expect(
        listPendingPreferenceWrites(userId),
        "reconnecting did not re-send the dropped preference write",
      ).toStrictEqual([]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCachedPreferences(userId).skipForwardMs).toBe(45_000);
    expect(win.count("online"), "the retry stayed armed after it succeeded").toBe(0);
  });

  it("reports the outstanding write so the sign-out drain can see it", async () => {
    const userId = "user-pending";
    vi.stubGlobal("window", fakeWindow());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
    await savePreferences(userId, DEFAULT_PREFERENCES, { smartRewind: false });

    expect(listPendingPreferenceWrites(userId)).toStrictEqual([
      { kind: "preferences", entityId: userId, queuedAt: expect.any(Number) },
    ]);
  });

  it("does not let a slow GET overwrite a write that landed while it was in flight", async () => {
    const userId = "user-clobber";
    vi.stubGlobal("window", fakeWindow());
    let releaseGet: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(null, { status: 200 });
      return new Promise<Response>((resolve) => {
        releaseGet = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const revalidation = fetchPreferences(userId);
    await vi.waitFor(() => expect(releaseGet).not.toBe(null));

    // The user changes a setting, and the server takes it — all while the GET
    // above is still open. Nothing pending is left behind by the time it lands.
    await savePreferences(userId, DEFAULT_PREFERENCES, { skipBackMs: 45_000 });
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);

    releaseGet!(Response.json({ preferences: DEFAULT_PREFERENCES }));

    await expect(revalidation).resolves.toMatchObject({ skipBackMs: 45_000 });
    expect(
      readCachedPreferences(userId).skipBackMs,
      "a stale GET overwrote a newer local write the server had already accepted",
    ).toBe(45_000);
  });
});
