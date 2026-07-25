"use client";

import { useEffect } from "react";

/**
 * `/offline` is not a screen any more, so it does not stay in the address bar.
 *
 * The rewrite is done with the history API rather than a server redirect or a
 * router navigation for two reasons: the service worker precaches this exact
 * document as its navigation fallback and cannot cache a redirect response,
 * and a router navigation would need the network — which is the one thing a
 * user arriving here may not have. The library is already on screen either
 * way; only the URL changes.
 */
export function OfflineRedirect() {
  useEffect(() => {
    if (window.location.pathname === "/offline") {
      window.history.replaceState(null, "", "/library");
    }
  }, []);

  return null;
}
