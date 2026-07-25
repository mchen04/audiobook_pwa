"use client";

import { useEffect } from "react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { retryAllPendingOfflineDeletions } from "@/lib/offline/deletion-journal";

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
    });
  }, []);

  return null;
}
