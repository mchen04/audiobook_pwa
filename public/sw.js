const CACHE_VERSION = "chapterline-shell-v5";
const MEDIA_CACHE = "chapterline-media-v2";
const LEGACY_MEDIA_CACHE = "chapterline-media-v1";
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
  if (!offlinePage) throw new Error("The required offline page was not cached.");
  const html = await offlinePage.clone().text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s\\]+/g) || [])];
  await Promise.all(assets.map((asset) => cache.add(asset)));
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
