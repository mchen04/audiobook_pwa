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
  it("precaches the document a warm launch is served, under a purgeable name", async () => {
    // Two other places key off these exact strings and would silently stop
    // matching if they drifted: the `activate` sweep deletes every other
    // `chapterline-shell-` cache, and `offline/account-purge.ts` keeps only
    // `/offline` and the static shell when an account switches.
    expect(constants).toContain('const CACHE_VERSION = "chapterline-shell-');
    expect(constants).toContain('const OFFLINE_URL = "/offline"');
    expect(constants).toContain("const PRECACHE = [OFFLINE_URL");
  });

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
