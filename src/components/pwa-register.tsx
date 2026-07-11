"use client";

import { useEffect } from "react";

import { retryAllPendingOfflineDeletions } from "@/lib/offline-library";

export function PwaRegister() {
  useEffect(() => {
    void retryAllPendingOfflineDeletions();
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }, []);

  return null;
}
