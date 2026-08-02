"use client";

import { useCallback, useState } from "react";

/**
 * Two flavours of "derived state with reset", named so they read as the idiom
 * they are. Neither uses an effect: a value tagged with the seed or key it was
 * made under is simply not carried across a different one.
 */

/**
 * A toggle that follows `seed` until the user works it themselves — and
 * follows it again the next time the seed changes.
 *
 * The library's Downloads link is `?device=1`, so the on-device facet follows
 * the URL until the chip is clicked, and follows the URL again the next time
 * that link is used.
 */
export function useSeedFollowingToggle(seed: boolean): [boolean, (on: boolean) => void] {
  const [choice, setChoice] = useState<{ from: boolean; on: boolean } | null>(null);
  const on = choice?.from === seed ? choice.on : seed;
  const set = useCallback((next: boolean) => setChoice({ from: seed, on: next }), [seed]);
  return [on, set];
}

/**
 * A page count that resets to 1 whenever `key` changes. A filter change resets
 * the page window without an effect: the window is simply not carried across a
 * different set of filters.
 */
export function usePageWindow(key: string): { pages: number; showMore: () => void } {
  const [pagination, setPagination] = useState({ key: "", pages: 1 });
  const pages = pagination.key === key ? pagination.pages : 1;
  const showMore = useCallback(() => setPagination({ key, pages: pages + 1 }), [key, pages]);
  return { pages, showMore };
}
