const CACHE_VERSION = "chapterline-shell-v3";
const MEDIA_CACHE = "chapterline-media-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

// The offline library must render on a cold offline launch, so its static
// chunks are captured at install time instead of relying on lazy runtime caching.
async function precacheShell() {
  const cache = await caches.open(CACHE_VERSION);
  await cache.addAll(PRECACHE);
  const offlinePage = await cache.match(OFFLINE_URL);
  if (!offlinePage) return;
  const html = await offlinePage.clone().text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
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
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
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
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
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

// Serves a downloaded MP3 with real Range support so offline seeking anywhere in
// the book works. Blob slices are disk-backed, so large books stay memory-safe.
async function serveOfflineMedia(request, pathname) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(pathname);
  if (!cached) return new Response("Download unavailable", { status: 404 });

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) return cached;

  const blob = await cached.blob();
  const range = parseRange(rangeHeader, blob.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` },
    });
  }

  const slice = blob.slice(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(slice.size),
      "Content-Range": `bytes ${range.start}-${range.end}/${blob.size}`,
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
