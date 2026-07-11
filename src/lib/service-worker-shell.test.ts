import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const constants = source.match(/const CACHE_VERSION[\s\S]*?const PRECACHE = \[[\s\S]*?\];/)?.[0];
const functionSource = source.match(/async function precacheShell\(\) \{[\s\S]*?\n\}/)?.[0];
if (!constants || !functionSource) throw new Error("The service-worker shell contract moved.");

const createPrecacheShell = new Function(
  "caches",
  `${constants}; ${functionSource}; return precacheShell;`,
) as (cacheStorage: unknown) => () => Promise<void>;

describe("service-worker shell installation", () => {
  it("caches every required chunk before installation succeeds", async () => {
    const cache = shellCache();
    const precacheShell = createPrecacheShell({ open: vi.fn().mockResolvedValue(cache) });

    await precacheShell();

    expect(cache.addAll).toHaveBeenCalledWith(["/offline", "/icons/icon-192.png"]);
    expect(cache.add).toHaveBeenCalledWith("/_next/static/chunks/offline.js");
  });

  it("rejects installation when a required chunk cannot be cached", async () => {
    const cache = shellCache();
    cache.add.mockRejectedValueOnce(new Error("chunk unavailable"));
    const precacheShell = createPrecacheShell({ open: vi.fn().mockResolvedValue(cache) });

    await expect(precacheShell()).rejects.toThrow("chunk unavailable");
  });
});

function shellCache() {
  return {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi
      .fn()
      .mockResolvedValue(new Response('<script src="/_next/static/chunks/offline.js"></script>')),
    add: vi.fn().mockResolvedValue(undefined),
  };
}
