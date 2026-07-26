// Bumped whenever the meaning of what is stored changes, not merely its
// contents: v6 is the first version whose shell document is served cache-first
// for the launch itself rather than only as an offline fallback. `activate`
// deletes every other `chapterline-shell-` cache, and account-purge.ts keys off
// the same prefix, so the prefix is part of the contract.
const CACHE_VERSION = "chapterline-shell-v6";
const MEDIA_CACHE = "chapterline-media-v2";
const LEGACY_MEDIA_CACHE = "chapterline-media-v1";
/**
 * The launch shell.
 *
 * `/offline` is not a second screen: it renders the same `AppShell` and the
 * same `LibraryClient` as `/library`, reading the same local mirror, and it
 * renders no user identity and no book rows. That is what makes one cached copy
 * safe to serve to any account signed in on this device
 * (`docs/local-first.md` sections 8 and 11), and it is why `account-purge.ts`
 * lists this exact path as the entry a sign-in sweep may leave in place.
 */
const OFFLINE_URL = "/offline";
/**
 * The manifest's `start_url`, exactly — query string and all.
 *
 * This is the URL a home-screen tap asks for, and it is the ONLY navigation the
 * static route below claims. It has to be spelled out to the character because
 * a routing rule resolves against Cache Storage by request URL: `?source=pwa`
 * is part of the key, nothing reads it (grep: it is a marker and no code
 * branches on it), and a rule written for a bare `/library` would miss here and
 * fall through to the network. `src/app/manifest.ts` owns the other copy of
 * this string; the two must not drift, and `service-worker-shell.test.ts` pins
 * that they do not.
 */
const LAUNCH_URL = "/library?source=pwa";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];
/**
 * How long a navigation the shell cannot answer may wait on the network.
 *
 * `fetch(request).catch(...)` alone is not a fallback: `.catch()` fires only
 * when fetch REJECTS, and a weak-but-alive mobile connection does not reject —
 * it stalls, for tens of seconds, showing nothing. Racing a timeout is what
 * turns that blank screen into a bounded wait.
 */
const NAVIGATION_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
  declareLaunchRoute(event);
});

/**
 * Answer the cold launch without waking this worker at all.
 *
 * Serving `/library` from Cache Storage in `fetch` below is not the whole job.
 * When a navigation arrives and the worker is not running — which on a real
 * home-screen tap is nearly always — the browser must boot it before it can
 * ask, and Chromium hedges that wait by speculatively fetching the same
 * document from the network (`ServiceWorkerAutoPreload`). The paint never waits
 * for that request and the page still comes from the cache, so it costs the
 * user nothing; it costs the SERVER a full `/library` render and its Postgres
 * queries on every cold launch, and the response is thrown away. Measured: six
 * discarded renders and 24 queries per benchmark run.
 *
 * A static route states the answer declaratively, so the browser satisfies the
 * navigation from the cache without starting the worker and has nothing left to
 * hedge against.
 *
 * TWO THINGS HERE ARE LOAD-BEARING, and getting either wrong is worse than not
 * doing this at all — a routing MISS goes straight to the network rather than
 * falling back to the `fetch` handler below, which would put the entire launch
 * document back on the wire:
 *
 *  - the condition matches the start_url EXACTLY, pathname and search. Every
 *    other navigation (`/library`, `/library?device=1`, `/books/:id`) is
 *    deliberately left to `serveNavigation`, which handles them correctly and
 *    is not query-sensitive. A rule written as a bare pathname would claim
 *    those too and miss on all of them.
 *  - `precacheShell` stores the shell under this exact key, so the lookup this
 *    rule performs is guaranteed to hit.
 *
 * `addRoutes` is Chromium-only and rejects a malformed rule, so it is guarded:
 * where it is unsupported nothing changes and the `fetch` handler stays
 * authoritative. This only ever changes WHO answers, never WHAT is answered.
 */
function declareLaunchRoute(event) {
  if (typeof event.addRoutes !== "function") return;
  try {
    const routed = event.addRoutes({
      condition: {
        urlPattern: { pathname: "/library", search: "source=pwa" },
        requestMode: "navigate",
      },
      source: "cache",
    });
    if (routed && typeof routed.catch === "function") routed.catch(() => undefined);
  } catch {
    // An unsupported rule shape must never fail the install. The worker then
    // answers the same navigation itself, one speculative request later.
  }
}

// The shell has to render with no network at all — it is what a warm launch is
// served — so its static chunks are captured here at install time rather than
// left to lazy runtime caching. Installation fails if any of them is missing,
// because a shell whose chunks are absent is a blank screen with extra steps.
async function precacheShell() {
  const cache = await caches.open(CACHE_VERSION);
  await cache.addAll(PRECACHE);
  const offlinePage = await cache.match(OFFLINE_URL);
  if (!offlinePage) throw new Error("The required offline page was not cached.");
  // The same bytes, stored a second time under the URL a launch actually asks
  // for, because the static route declared in `install` resolves by request URL
  // and a miss would go to the network. `serveNavigation` does not need this —
  // it maps /library onto the /offline entry itself — so this key exists purely
  // to make the declarative rule and the handler agree on one document.
  await cache.put(LAUNCH_URL, offlinePage.clone());
  const html = await offlinePage.clone().text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  await Promise.all(assets.map((asset) => cache.add(asset)));
  await dropSupersededChunks(cache, assets);
}

/**
 * Forget the chunks the shell no longer references.
 *
 * Every deployment gives the build new `/_next/static` names, and this function
 * re-runs on each `REFRESH_SHELL`. Without a sweep the old names stay cached
 * forever: the shell cache grows by a full chunk set per deploy, against the
 * same origin quota the downloaded audio competes for — and that audio is the
 * only copy in existence, so the eviction this would eventually provoke costs
 * the user something unrecoverable. The cache-version bump in `activate` does
 * not cover it either, since the version changes with the cache's MEANING, not
 * with the build.
 *
 * Deliberately conservative: only `/_next/static` entries are considered, and
 * only ones the freshly-read shell does not reference. The shell document, the
 * launch key and the icons are never touched here.
 */
async function dropSupersededChunks(cache, assets) {
  const keep = new Set(assets);
  const stale = (await cache.keys()).filter((request) => {
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/_next/static/") && !keep.has(pathname);
  });
  await Promise.all(stale.map((request) => cache.delete(request)));
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith("chapterline-shell-") && key !== CACHE_VERSION)
              .map((key) => caches.delete(key)),
          ),
        ),
      caches.delete(LEGACY_MEDIA_CACHE),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  // The shell is a cached copy of a built document, and every deployment gives
  // the build new `/_next/static` chunk names. Without this the device would
  // keep launching into the old build until `sw.js` itself changed bytes, which
  // it does not do per build. The page asks for the refresh once it has gone
  // idle after launch, so the round trip is never on the paint path.
  if (event.data?.type === "REFRESH_SHELL") {
    event.waitUntil(precacheShell().catch(() => undefined));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/offline-media/")) {
    event.respondWith(serveOfflineMedia(request, url.pathname));
    return;
  }

  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(serveNavigation(request, url.pathname));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
  }
});

/**
 * The launch path (`docs/local-first.md` section 8).
 *
 * `/library` is answered from Cache Storage without consulting the network at
 * all, because the document it needs holds no book data and no user identity —
 * the books come from this device's IndexedDB mirror once the shell is running.
 * That is the whole point: a cold database and airplane mode cost exactly what
 * wifi costs, because none of them are on this path.
 *
 * Everything else goes to the network first, because it has something the
 * device does not (the player page's chapters and history, the auth pages), but
 * bounded: a stalled connection falls back to whatever this device can render
 * for itself instead of showing nothing for a minute.
 */
async function serveNavigation(request, pathname) {
  const cache = await caches.open(CACHE_VERSION);

  if (pathname === "/library") {
    const shell = await cache.match(OFFLINE_URL);
    if (shell) return shell;
  }

  const live = await fetchWithinBudget(request);
  if (live) return live;

  // The network did not answer in time. Anything the device can render from its
  // own mirror gets the shell. An auth page cannot be rendered from local data,
  // and handing it the library shell would bounce a signed-out visitor between
  // /login and the shell forever, so it gets an honest notice instead.
  if (rendersFromLocalData(pathname)) {
    const shell = await cache.match(OFFLINE_URL);
    if (shell) return shell;
  }
  return unreachableDocument();
}

/**
 * Routes the shell can stand in for. `/books/:id` is included because the
 * shell's `LibraryClient` reads the book id out of the URL and plays this
 * device's own copy — which is why opening a book needs no "am I online?"
 * question anywhere in the app.
 */
function rendersFromLocalData(pathname) {
  return (
    pathname === "/" ||
    pathname === "/library" ||
    pathname === OFFLINE_URL ||
    pathname.startsWith("/books/")
  );
}

/** Resolves with the response, or with null once the budget is spent. */
function fetchWithinBudget(request) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    fetch(request).then(
      (response) => settle(response),
      () => settle(null),
    );
  });
}

/** Last resort: no cached shell and no reachable server. */
function unreachableDocument() {
  return new Response(
    "<!doctype html><html lang=en><meta charset=utf-8>" +
      '<meta name=viewport content="width=device-width,initial-scale=1">' +
      "<title>Hark is offline</title>" +
      "<style>body{font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;" +
      "min-height:100dvh;padding:2rem;text-align:center}</style>" +
      "<h1>Hark can&rsquo;t reach the network</h1>" +
      "<p>Your library and your audiobooks are still on this device. " +
      "Reopen Hark once you have a connection.</p>" +
      '<p><a href="/library">Try again</a></p>',
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

// Streams ranges from independently cached chunks. This avoids turning a
// multi-gigabyte audiobook into one Blob in the memory-constrained iOS process.
async function serveOfflineMedia(request, pathname) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(pathname);
  if (!cached) return new Response("Download unavailable", { status: 404 });
  const format = cached.headers.get("X-Chapterline-Media-Format");
  // Entries without a format header are stored whole (cover art) and are
  // served as-is; only chunked manifests need range assembly below.
  if (!format) return cached;
  if (format !== "chunked-v1") {
    return new Response("Unsupported saved media format", { status: 410 });
  }
  const manifest = await cached.json();
  // The body's format field and the header are written together at import;
  // asserting both keeps the two representations from silently diverging.
  if (manifest.format !== "chapterline-chunked-media-v1") {
    return new Response("Unsupported saved media format", { status: 410 });
  }
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) return streamWholeMedia(cache, pathname, manifest);

  const range = parseRange(rangeHeader, manifest.byteSize);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${manifest.byteSize}` },
    });
  }
  return new Response(streamMediaRange(cache, pathname, manifest, range.start, range.end), {
    status: 206,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${manifest.byteSize}`,
      "Accept-Ranges": "bytes",
    },
  });
}

function streamMediaRange(cache, pathname, manifest, start, end) {
  let index = Math.floor(start / manifest.chunkSize);
  const last = Math.floor(end / manifest.chunkSize);
  return new ReadableStream({
    async pull(controller) {
      if (index > last) {
        controller.close();
        return;
      }
      const response = await cache.match(`${pathname}/chunk/${index}`);
      if (!response) {
        controller.error(new Error("Download unavailable"));
        return;
      }
      const blob = await response.blob();
      const chunkStart = index * manifest.chunkSize;
      const slice = blob.slice(
        Math.max(0, start - chunkStart),
        Math.min(blob.size, end - chunkStart + 1),
      );
      controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
      index += 1;
    },
  });
}

function streamWholeMedia(cache, pathname, manifest) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= manifest.chunkCount) {
        controller.close();
        return;
      }
      const response = await cache.match(`${pathname}/chunk/${index}`);
      if (!response) {
        controller.error(new Error("Download unavailable"));
        return;
      }
      controller.enqueue(new Uint8Array(await response.arrayBuffer()));
      index += 1;
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(manifest.byteSize),
      "Accept-Ranges": "bytes",
    },
  });
}

function parseRange(header, totalSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || totalSize === 0) return null;
  if (!match[1]) {
    const suffixLength = Math.min(Number(match[2]), totalSize);
    return suffixLength > 0 ? { start: totalSize - suffixLength, end: totalSize - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  return start < totalSize && start <= end ? { start, end } : null;
}
