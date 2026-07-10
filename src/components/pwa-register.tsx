"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }, []);

  return null;
}
