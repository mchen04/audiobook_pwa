import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The launch path, pinned against the real service-worker source.
 *
 * `public/sw.js` cannot be imported — it is a classic worker script with no
 * exports — so its navigation handler is lifted out of the file and evaluated
 * with its collaborators injected. Everything under test below is the shipped
 * code, character for character; only `caches`, `fetch` and the timer are
 * substituted, which is what makes "never touched the network" and "answered
 * within the budget" assertable at all.
 */
const source = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
const constants = source.match(
  /const CACHE_VERSION[\s\S]*?const NAVIGATION_TIMEOUT_MS = \d+;/,
)?.[0];
// Everything from the navigation handler down to where the media section
// starts. If the block moves or is renamed this throws instead of silently
// testing a smaller region.
const navigationSource = source.match(
  /async function serveNavigation\([\s\S]*?(?=\n\/\/ Streams ranges from)/,
)?.[0];
if (!constants || !navigationSource) {
  throw new Error("The service-worker navigation contract moved.");
}

type Timer = { run: () => void; ms: number; cancelled: boolean };
type ServeNavigation = (request: Request, pathname: string) => Promise<Response>;

const SHELL_HTML = "<!doctype html><title>Library shell</title>";

let cache: {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  addAll: ReturnType<typeof vi.fn>;
};
let entries: Map<string, string>;
let timers: Timer[];
let fetchMock: ReturnType<typeof vi.fn>;
let serveNavigation: ServeNavigation;
let rendersFromLocalData: (pathname: string) => boolean;

beforeEach(() => {
  entries = new Map();
  timers = [];
  cache = {
    match: vi.fn(async (key: string) => {
      const body = entries.get(key);
      return body === undefined ? undefined : new Response(body);
    }),
    put: vi.fn(async () => undefined),
    add: vi.fn(async () => undefined),
    addAll: vi.fn(async () => undefined),
  };
  fetchMock = vi.fn(async () => new Response("live document from the server"));

  const setTimeoutStub = (run: () => void, ms: number) => {
    timers.push({ run, ms, cancelled: false });
    return timers.length;
  };
  const clearTimeoutStub = (handle: number) => {
    const timer = timers[handle - 1];
    if (timer) timer.cancelled = true;
  };

  const build = new Function(
    "caches",
    "fetch",
    "setTimeout",
    "clearTimeout",
    `${constants}\n${navigationSource}\nreturn { serveNavigation, rendersFromLocalData };`,
  ) as (
    caches: unknown,
    fetch: unknown,
    setTimeout: unknown,
    clearTimeout: unknown,
  ) => { serveNavigation: ServeNavigation; rendersFromLocalData: (pathname: string) => boolean };

  const built = build(
    { open: vi.fn(async () => cache) },
    fetchMock,
    setTimeoutStub,
    clearTimeoutStub,
  );
  serveNavigation = built.serveNavigation;
  rendersFromLocalData = built.rendersFromLocalData;
});

/** Lets the handler's pending microtasks run without advancing the budget. */
async function settleMicrotasks() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** Fires every timer the handler is still waiting on. */
function spendTheBudget() {
  for (const timer of timers) if (!timer.cancelled) timer.run();
}

/**
 * The document request a navigation produces. `mode: "navigate"` cannot be
 * constructed outside a browser, and `serveNavigation` does not read it — the
 * fetch listener above it is what routes navigations here.
 */
function navigate(pathname: string) {
  return new Request(`https://hark.test${pathname}`);
}

describe("service-worker navigation", () => {
  it("serves a warm library launch from Cache Storage without touching the network", async () => {
    entries.set("/offline", SHELL_HTML);

    const response = await serveNavigation(navigate("/library"), "/library");

    expect(await response.text()).toBe(SHELL_HTML);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the shell for the launch URL the manifest actually uses", async () => {
    entries.set("/offline", SHELL_HTML);

    const response = await serveNavigation(
      new Request("https://hark.test/library?source=pwa"),
      "/library",
    );

    expect(await response.text()).toBe(SHELL_HTML);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls through to the network on a first install, when there is no shell yet", async () => {
    const response = await serveNavigation(navigate("/library"), "/library");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("live document from the server");
  });

  it("bounds a first install: a connection that never answers still shows something", async () => {
    entries.set("/offline", SHELL_HTML);
    // A weak-but-alive connection: the fetch neither resolves nor rejects, so
    // `.catch()` would never fire and the user would stare at nothing.
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));

    const pending = serveNavigation(navigate("/books/abc"), "/books/abc");
    await settleMicrotasks();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBeLessThanOrEqual(3_000);

    spendTheBudget();
    expect(await (await pending).text()).toBe(SHELL_HTML);
  });

  it("prefers the live document for a book page, which the shell cannot fully render", async () => {
    entries.set("/offline", SHELL_HTML);

    const response = await serveNavigation(navigate("/books/abc"), "/books/abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("live document from the server");
  });

  it("falls back to the shell when a book page cannot be fetched", async () => {
    entries.set("/offline", SHELL_HTML);
    fetchMock.mockRejectedValue(new Error("offline"));

    const response = await serveNavigation(navigate("/books/abc"), "/books/abc");

    expect(await response.text()).toBe(SHELL_HTML);
  });

  it("never answers an auth page with the library shell", async () => {
    entries.set("/offline", SHELL_HTML);
    fetchMock.mockRejectedValue(new Error("offline"));

    const response = await serveNavigation(navigate("/login"), "/login");
    const body = await response.text();

    // Serving the library shell here would render a library with no active
    // user, which redirects to /login, which would be served the shell again.
    expect(body).not.toBe(SHELL_HTML);
    expect(body).toContain("can&rsquo;t reach the network");
    expect(rendersFromLocalData("/login")).toBe(false);
  });

  it("never writes a navigation response into the shell cache", async () => {
    // The shell is user-agnostic only because it is the prerendered `/offline`
    // document. Caching a server-rendered navigation would put one account's
    // page where the next account's launch reads from.
    await serveNavigation(navigate("/library"), "/library");
    await serveNavigation(navigate("/books/abc"), "/books/abc");
    await serveNavigation(navigate("/settings"), "/settings");

    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.add).not.toHaveBeenCalled();
    expect(cache.addAll).not.toHaveBeenCalled();
  });
});
