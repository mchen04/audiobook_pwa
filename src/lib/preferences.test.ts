import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PREFERENCES,
  fetchPreferences,
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
