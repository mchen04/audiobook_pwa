import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PREFERENCES,
  fetchPreferences,
  flushPendingPreferences,
  listPendingPreferenceWrites,
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_LEGACY_REPLAY_HEADER,
  PREFERENCES_WRITE_ID_HEADER,
  readCachedPreferences,
  savePreferences,
} from "./preferences";
import { resolveStartPosition } from "./playback-core";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
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

function currentAcknowledgment(
  preferencesPatch: Partial<typeof DEFAULT_PREFERENCES>,
  init?: RequestInit,
): Response {
  const acknowledgedPatch = JSON.parse(String(init?.body ?? "{}")) as Partial<
    typeof DEFAULT_PREFERENCES
  >;
  return Response.json({
    preferences: { ...DEFAULT_PREFERENCES, ...preferencesPatch },
    defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
    acknowledgedWriteId: new Headers(init?.headers).get(PREFERENCES_WRITE_ID_HEADER),
    acknowledgedPatch,
  });
}

function acknowledgeCurrentRequest(_url: string, init?: RequestInit): Response {
  const patch = JSON.parse(String(init?.body ?? "{}")) as Partial<typeof DEFAULT_PREFERENCES>;
  return currentAcknowledgment(patch, init);
}

describe("preference durability", () => {
  it("retains a legacy offline write until the server acknowledges it", async () => {
    localStorage.setItem(
      "chapterline:preferences:user-legacy-pending",
      JSON.stringify({
        preferences: {
          ...DEFAULT_PREFERENCES,
          skipBackMs: 45_000,
          smartRewind: true,
        },
        revision: 7,
        pendingRevision: 7,
        pendingSince: 1234,
      }),
    );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(acknowledgeCurrentRequest)
      .mockResolvedValueOnce(Response.json({ preferences: DEFAULT_PREFERENCES }));
    vi.stubGlobal("fetch", fetchMock);

    expect(readCachedPreferences("user-legacy-pending")).toMatchObject({
      skipBackMs: 45_000,
      smartRewind: false,
    });
    await fetchPreferences("user-legacy-pending");

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      ...DEFAULT_PREFERENCES,
      skipBackMs: 45_000,
      smartRewind: true,
    });
    expect(listPendingPreferenceWrites("user-legacy-pending")).toStrictEqual([]);
  });

  it("replays a legacy payload before a newer field-level offline patch", async () => {
    const userId = "user-mixed-pending";
    localStorage.setItem(
      `chapterline:preferences:${userId}`,
      JSON.stringify({
        preferences: {
          ...DEFAULT_PREFERENCES,
          skipBackMs: 45_000,
          smartRewind: true,
        },
        revision: 7,
        pendingRevision: 7,
        pendingSince: 1234,
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await savePreferences(
      userId,
      { ...DEFAULT_PREFERENCES, skipBackMs: 45_000 },
      { autoplayNextInCollection: true },
    );

    const replay = vi
      .fn()
      .mockImplementationOnce(acknowledgeCurrentRequest)
      .mockImplementationOnce(acknowledgeCurrentRequest);
    await flushPendingPreferences(userId, replay);

    expect(replay).toHaveBeenCalledTimes(2);
    expect(JSON.parse(replay.mock.calls[0]![1].body)).toEqual({
      ...DEFAULT_PREFERENCES,
      skipBackMs: 45_000,
      smartRewind: true,
    });
    expect(JSON.parse(replay.mock.calls[1]![1].body)).toEqual({
      autoplayNextInCollection: true,
    });
    expect(new Headers(replay.mock.calls[1]![1].headers).get(PREFERENCES_DEFAULTS_HEADER)).toBe(
      String(PREFERENCES_DEFAULTS_VERSION),
    );
    expect(readCachedPreferences(userId)).toMatchObject({
      skipBackMs: 45_000,
      smartRewind: false,
      autoplayNextInCollection: true,
    });
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
  });

  it("checkpoints a legacy acknowledgment before a newer patch fails", async () => {
    const userId = "user-piece-checkpoint";
    localStorage.setItem(
      `chapterline:preferences:${userId}`,
      JSON.stringify({
        preferences: {
          ...DEFAULT_PREFERENCES,
          skipBackMs: 45_000,
          smartRewind: true,
        },
        revision: 7,
        pendingRevision: 7,
        pendingSince: 1234,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(acknowledgeCurrentRequest)
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    );

    await savePreferences(
      userId,
      { ...DEFAULT_PREFERENCES, skipBackMs: 45_000 },
      { autoplayNextInCollection: true },
    );
    expect(listPendingPreferenceWrites(userId)).toHaveLength(1);

    const retry: typeof fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      currentAcknowledgment({ skipBackMs: 10_000, autoplayNextInCollection: true }, init),
    );
    await flushPendingPreferences(userId, retry);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(retry).mock.calls[0]![1]?.body))).toEqual({
      autoplayNextInCollection: true,
    });
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
  });

  it("does not replay a legacy piece acknowledged while a newer patch was queued", async () => {
    const userId = "user-legacy-in-flight";
    localStorage.setItem(
      `chapterline:preferences:${userId}`,
      JSON.stringify({
        preferences: {
          ...DEFAULT_PREFERENCES,
          skipBackMs: 45_000,
          smartRewind: true,
        },
        revision: 7,
        pendingRevision: 7,
        pendingSince: 1234,
      }),
    );
    let acknowledgeLegacy: ((response: Response) => void) | null = null;
    let legacyRequest: RequestInit | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            legacyRequest = init;
            acknowledgeLegacy = resolve;
          }),
      )
      .mockImplementationOnce(acknowledgeCurrentRequest);
    vi.stubGlobal("fetch", fetchMock);

    const legacyFlush = flushPendingPreferences(userId);
    await vi.waitFor(() => expect(acknowledgeLegacy).not.toBe(null));
    const newerWrite = savePreferences(
      userId,
      { ...DEFAULT_PREFERENCES, skipBackMs: 45_000 },
      { autoplayNextInCollection: true },
    );
    acknowledgeLegacy!(
      currentAcknowledgment(
        { ...DEFAULT_PREFERENCES, skipBackMs: 45_000, smartRewind: false },
        legacyRequest,
      ),
    );
    await Promise.all([legacyFlush, newerWrite]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      autoplayNextInCollection: true,
    });
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
  });

  it("keeps a current opt-in pending when a predecessor server answers 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ preferences: DEFAULT_PREFERENCES })),
    );

    await savePreferences("user-old-ack", DEFAULT_PREFERENCES, { smartRewind: true });

    expect(readCachedPreferences("user-old-ack").smartRewind).toBe(true);
    expect(listPendingPreferenceWrites("user-old-ack")).toHaveLength(1);
  });

  it("keeps a current write pending when the response does not echo its field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          preferences: {},
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        }),
      ),
    );

    await savePreferences("user-incomplete-ack", DEFAULT_PREFERENCES, { smartRewind: true });

    expect(listPendingPreferenceWrites("user-incomplete-ack")).toHaveLength(1);
  });

  it("keeps a failed write pending and replays it before accepting server state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(acknowledgeCurrentRequest)
      .mockResolvedValueOnce(
        Response.json({
          preferences: { ...DEFAULT_PREFERENCES, smartRewind: true },
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences("user-a", DEFAULT_PREFERENCES, { smartRewind: false });
    expect(readCachedPreferences("user-a").smartRewind).toBe(false);

    await expect(fetchPreferences("user-a")).resolves.toMatchObject({ smartRewind: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ smartRewind: false });
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get(PREFERENCES_DEFAULTS_HEADER)).toBe(
      String(PREFERENCES_DEFAULTS_VERSION),
    );
  });

  it("reuses its write id so a lost response retry cannot overwrite another device", async () => {
    const userId = "user-lost-response";
    let serverPreferences = DEFAULT_PREFERENCES;
    const receipts = new Map<string, Partial<typeof DEFAULT_PREFERENCES>>();
    const observedWriteIds: string[] = [];
    const observedWriteUrls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return Response.json({
          preferences: serverPreferences,
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        });
      }
      observedWriteUrls.push(String(url));
      const writeId = new Headers(init.headers).get(PREFERENCES_WRITE_ID_HEADER);
      if (!writeId) throw new Error("current preference PATCH carried no write id");
      const patch = JSON.parse(String(init.body)) as Partial<typeof DEFAULT_PREFERENCES>;
      observedWriteIds.push(writeId);
      const receipt = receipts.get(writeId);
      if (receipt) {
        return Response.json({
          preferences: serverPreferences,
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
          acknowledgedWriteId: writeId,
          acknowledgedPatch: receipt,
        });
      }

      receipts.set(writeId, patch);
      serverPreferences = { ...serverPreferences, ...patch };
      // The server committed A, but A never received the response. Device B
      // then chose a newer value before A came back online.
      serverPreferences = { ...serverPreferences, skipBackMs: 10_000 };
      throw new Error("response lost after commit");
    });
    vi.stubGlobal("fetch", fetchMock);

    await savePreferences(userId, DEFAULT_PREFERENCES, { skipBackMs: 45_000 });
    expect(listPendingPreferenceWrites(userId)).toHaveLength(1);

    await expect(fetchPreferences(userId)).resolves.toMatchObject({ skipBackMs: 10_000 });
    expect(observedWriteIds).toHaveLength(2);
    expect(observedWriteIds[1]).toBe(observedWriteIds[0]);
    expect(observedWriteUrls).toStrictEqual(["/api/preferences/v2", "/api/preferences/v2"]);
    expect(readCachedPreferences(userId).skipBackMs).toBe(10_000);
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
  });

  it("checkpoints an in-flight field before sending newer fields under a fresh receipt", async () => {
    const userId = "user-inflight-append";
    let serverPreferences = DEFAULT_PREFERENCES;
    let releaseFirst: ((response: Response) => void) | null = null;
    let firstRequest: RequestInit | undefined;
    const requests: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return Response.json({
          preferences: serverPreferences,
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        });
      }
      requests.push(init);
      const patch = JSON.parse(String(init.body)) as Partial<typeof DEFAULT_PREFERENCES>;
      if (requests.length === 1) {
        serverPreferences = { ...serverPreferences, ...patch };
        firstRequest = init;
        return new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      serverPreferences = { ...serverPreferences, ...patch };
      return currentAcknowledgment(serverPreferences, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = savePreferences(userId, DEFAULT_PREFERENCES, { skipBackMs: 45_000 });
    await vi.waitFor(() => expect(releaseFirst).not.toBe(null));
    const second = savePreferences(
      userId,
      { ...DEFAULT_PREFERENCES, skipBackMs: 45_000 },
      { autoplayNextInCollection: true },
    );

    // Another device changes A's field after A committed but before its
    // delayed acknowledgment reaches this device.
    serverPreferences = { ...serverPreferences, skipBackMs: 10_000 };
    releaseFirst!(currentAcknowledgment({ skipBackMs: 45_000 }, firstRequest));
    await Promise.all([first, second]);

    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]!.body))).toEqual({
      autoplayNextInCollection: true,
    });
    expect(new Headers(requests[1]!.headers).get(PREFERENCES_WRITE_ID_HEADER)).not.toBe(
      new Headers(requests[0]!.headers).get(PREFERENCES_WRITE_ID_HEADER),
    );
    await expect(fetchPreferences(userId)).resolves.toMatchObject({
      skipBackMs: 10_000,
      autoplayNextInCollection: true,
    });
  });

  it("receipts a migrated legacy retry without replaying it over another device", async () => {
    const userId = "user-legacy-lost-response";
    localStorage.setItem(
      `chapterline:preferences:${userId}`,
      JSON.stringify({
        preferences: {
          ...DEFAULT_PREFERENCES,
          skipBackMs: 45_000,
          smartRewind: true,
        },
        revision: 7,
        pendingRevision: 7,
        pendingSince: 1234,
      }),
    );
    let serverPreferences = DEFAULT_PREFERENCES;
    const receipts = new Map<string, Partial<typeof DEFAULT_PREFERENCES>>();
    const writeIds: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        return Response.json({
          preferences: serverPreferences,
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
        });
      }
      expect(String(url)).toBe("/api/preferences/v2");
      expect(new Headers(init.headers).get(PREFERENCES_LEGACY_REPLAY_HEADER)).toBe("1");
      expect(new Headers(init.headers).get(PREFERENCES_DEFAULTS_HEADER)).toBe(null);
      const writeId = new Headers(init.headers).get(PREFERENCES_WRITE_ID_HEADER);
      if (!writeId) throw new Error("legacy replay carried no receipt id");
      writeIds.push(writeId);
      const body = JSON.parse(String(init.body)) as Partial<typeof DEFAULT_PREFERENCES>;
      const receipt = receipts.get(writeId);
      if (receipt) {
        return Response.json({
          preferences: serverPreferences,
          defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
          acknowledgedWriteId: writeId,
          acknowledgedPatch: receipt,
        });
      }
      receipts.set(writeId, body);
      serverPreferences = { ...serverPreferences, ...body, smartRewind: false };
      serverPreferences = { ...serverPreferences, skipBackMs: 10_000 };
      throw new Error("legacy response lost after commit");
    });
    vi.stubGlobal("fetch", fetchMock);

    await flushPendingPreferences(userId);
    expect(listPendingPreferenceWrites(userId)).toHaveLength(1);
    await expect(fetchPreferences(userId)).resolves.toMatchObject({ skipBackMs: 10_000 });

    expect(writeIds).toHaveLength(2);
    expect(writeIds[1]).toBe(writeIds[0]);
    expect(listPendingPreferenceWrites(userId)).toStrictEqual([]);
  });

  it("serializes rapid writes and leaves the newest value cached", async () => {
    const fetchMock = vi.fn(acknowledgeCurrentRequest);
    vi.stubGlobal("fetch", fetchMock);

    const first = savePreferences("user-a", DEFAULT_PREFERENCES, { skipBackMs: 10_000 });
    const second = savePreferences(
      "user-a",
      { ...DEFAULT_PREFERENCES, skipBackMs: 10_000 },
      { skipBackMs: 45_000 },
    );
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      skipBackMs: 45_000,
    });
    expect(readCachedPreferences("user-a").skipBackMs).toBe(45_000);
  });

  it("does not let an acknowledgment from before a purge clear a new failed write", async () => {
    const userId = "user-purge-boundary";
    let acknowledgeOld: ((response: Response) => void) | null = null;
    let oldRequest: RequestInit | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            oldRequest = init;
            acknowledgeOld = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const oldWrite = savePreferences(userId, DEFAULT_PREFERENCES, { skipBackMs: 45_000 });
    await vi.waitFor(() => expect(acknowledgeOld).not.toBe(null));
    const oldRetry = flushPendingPreferences(userId);

    // Sign-out deletes the entire envelope, so the next session starts its
    // numeric revision counter at 1 again while the timed-out request remains
    // alive. Its opaque write identity must distinguish the two, and the retry
    // queued behind the old request must become a no-op.
    localStorage.removeItem(`chapterline:preferences:${userId}`);
    const newWrite = savePreferences(userId, DEFAULT_PREFERENCES, { skipForwardMs: 45_000 });
    acknowledgeOld!(currentAcknowledgment({ skipBackMs: 45_000 }, oldRequest));
    await Promise.all([oldWrite, oldRetry, newWrite]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCachedPreferences(userId).skipForwardMs).toBe(45_000);
    expect(
      listPendingPreferenceWrites(userId),
      "the old acknowledgment erased the new write's retry/reporting record",
    ).toHaveLength(1);
  });
});

describe("exact resume defaults", () => {
  it("does not move a returning listener behind the durable position unless they opt in", () => {
    expect(
      resolveStartPosition({
        storedPositionMs: 13_342_902,
        durationMs: 20_000_000,
        smartRewindEnabled: DEFAULT_PREFERENCES.smartRewind,
        msSinceLastPause: 2 * 60 * 60 * 1000,
      }),
    ).toEqual({ startAtMs: 13_342_902, appliedRewindMs: 0 });
  });

  it("resets every legacy cached rewind before network revalidation", () => {
    localStorage.setItem(
      "chapterline:preferences:user-legacy-default",
      JSON.stringify({
        preferences: { ...DEFAULT_PREFERENCES, smartRewind: true },
        revision: 0,
        pendingRevision: null,
        pendingSince: 0,
      }),
    );
    localStorage.setItem(
      "chapterline:preferences:user-legacy-revision",
      JSON.stringify({
        preferences: { ...DEFAULT_PREFERENCES, smartRewind: true },
        revision: 1,
        pendingRevision: null,
        pendingSince: 0,
      }),
    );
    localStorage.setItem(
      "chapterline:preferences:user-current-opt-in",
      JSON.stringify({
        preferences: { ...DEFAULT_PREFERENCES, smartRewind: true },
        defaultsVersion: 2,
        revision: 1,
        pendingRevision: null,
        pendingSince: 0,
      }),
    );
    localStorage.setItem(
      "chapterline:preferences:user-raw-legacy",
      JSON.stringify({ ...DEFAULT_PREFERENCES, smartRewind: true }),
    );

    expect(readCachedPreferences("user-legacy-default").smartRewind).toBe(false);
    expect(readCachedPreferences("user-legacy-revision").smartRewind).toBe(false);
    expect(readCachedPreferences("user-current-opt-in").smartRewind).toBe(true);
    expect(readCachedPreferences("user-raw-legacy").smartRewind).toBe(false);
  });

  it("does not adopt an ambiguous rewind from a predecessor server", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ preferences: { ...DEFAULT_PREFERENCES, smartRewind: true } }),
        ),
    );

    await expect(fetchPreferences("user-old-server")).resolves.toMatchObject({
      smartRewind: false,
    });
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
      .mockImplementationOnce(acknowledgeCurrentRequest);
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
      if (init?.method === "PATCH") return acknowledgeCurrentRequest(_url, init);
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
