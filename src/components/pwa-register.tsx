"use client";

import { useEffect } from "react";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";
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
  }, []);

  return null;
}
