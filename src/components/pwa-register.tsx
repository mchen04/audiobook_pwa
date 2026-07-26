"use client";

import { useEffect } from "react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { retryAllPendingOfflineDeletions } from "@/lib/offline/deletion-journal";

/**
 * Pull the import path's lazy chunks into the cache while the network is here.
 *
 * `local-import.ts` reaches the MP3 parser through `await import("music-metadata")`
 * and the fingerprint hasher through `await import("./media-hash")`. Both are
 * heavy and rightly code-split — but a code-split chunk is not referenced by the
 * shell document, so `precacheShell` never sees it, and the service worker's
 * runtime caching only stores a chunk it has actually been asked for. Nobody
 * asks until the moment someone picks a file.
 *
 * The result was that importing a book with no network failed outright, with
 * "Failed to load chunk" where the audiobook should have been. That is the one
 * thing an app whose whole promise is "the network is not your problem" may not
 * do — and it also made the eviction recovery of `docs/local-first.md` §10
 * unreachable exactly when it is needed: on a plane, with the MP3 in Files and
 * the audio evicted.
 *
 * Fetching them costs a request each, once, and only after the launch has
 * painted — the same "the launch belongs to the user" rule as the shell refresh
 * above. A failure here is not worth reporting: it leaves the import exactly as
 * capable as it was before.
 *
 * `data-import-ready` marks the point where an import could survive losing the
 * network, in the same spirit as `data-launch-ready`. Whether the modules are
 * resolved is otherwise invisible, and a test that guessed at it with a sleep
 * would be reporting a caching race as a merge bug.
 */
function warmImportChunks(): void {
  void Promise.allSettled([warmMp3Parser(), import("@/lib/media-hash")]).then(() => {
    document.documentElement.dataset.importReady = "1";
  });
}

/**
 * Resolving `music-metadata` is not enough, and this is the hop that was still
 * missing: the package picks a parser out of a loader table and reaches the one
 * it needs through a SECOND dynamic import — `mpegParserLoader.load()` is
 * `import("./MpegParser.js")` — which runs only when something is actually
 * parsed. Warming the entry point therefore resolved the table and left the
 * chunk that does the work on the network, so an import with no network still
 * died with "Failed to load chunk", one hop further along than before.
 *
 * So this parses something: 417 bytes carrying an MPEG-1 Layer 3 frame header,
 * synthesized here rather than shipped as a fixture. Going through the real
 * `parseBlob` means whatever chunk an MP3 needs is the chunk this fetches, with
 * no assumption about the package's internal layout — and its `exports` map
 * offers no subpath to reach the parser directly anyway. The result is thrown
 * away; only the resolved module matters.
 */
async function warmMp3Parser(): Promise<void> {
  const { parseBlob } = await import("music-metadata");
  await parseBlob(new Blob([mp3ParserWarmupFrame()], { type: "audio/mpeg" }), { duration: false });
}

/**
 * One MPEG-1 Layer 3 frame: 128 kbps at 44.1 kHz, so 417 bytes, of which only
 * the four header bytes matter.
 *
 * Exported because a warm-up that quietly parses nothing is indistinguishable
 * from a warm-up that works — it would resolve no parser, set the ready flag,
 * and leave the offline import to fail on a chunk fetch. `pwa-register.test.ts`
 * puts these bytes through the real parser and reads the container back.
 */
export function mp3ParserWarmupFrame(): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(new ArrayBuffer(417));
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

export function PwaRegister() {
  useEffect(() => {
    // Auth pages have no signed-in user and should do zero storage work; on
    // signed-in loads the journal repair waits for idle so it never contends
    // with the player's own IndexedDB reads during startup.
    if (localStorage.getItem(ACTIVE_USER_KEY)) {
      const idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback
          : (callback: () => void) => window.setTimeout(callback, 3_000);
      idle(() => void retryAllPendingOfflineDeletions());
    }
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker.register("/sw.js", { scope: "/" });

    // The cached shell is a copy of a built document, and a deployment renames
    // every `/_next/static` chunk it points at. `sw.js` itself does not change
    // per build, so nothing else would ever refresh it. This is deliberately
    // the last thing the page does: it is a network round trip, and the launch
    // belongs to the user.
    return afterLaunchPaint(() => {
      if (!navigator.onLine) return;
      void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage({ type: "REFRESH_SHELL" }))
        .catch(() => undefined);
      warmImportChunks();
    });
  }, []);

  return null;
}
