"use client";

/**
 * When background revalidation is allowed to touch the network.
 *
 * `docs/local-first.md` section 8 puts the session check and the sync pull
 * *after* paint, and means it literally. On a warm launch the document comes
 * out of Cache Storage, so the only thing standing between the icon tap and the
 * user's books is this device's own work: hydrate, open IndexedDB, read the
 * mirror, paint. A `fetch` issued into that window does not merely fail to
 * help — it competes for the same main thread and the same connection budget
 * as the frame launch is measured on.
 *
 * So revalidation waits for two things, and both matter:
 *
 *  1. **The library is on screen.** `markLaunchPainted()` is called from the
 *     same render that sets `data-launch-ready`, so "after paint" means the
 *     user's real content, not merely a later microtask. Pages that never show
 *     a library — the player, settings — have nothing to wait for, so a
 *     deadline releases them instead.
 *  2. **The frame has been left alone for a moment.** `SETTLE_MS` of quiet
 *     after that render is deliberate: the first half-second belongs to the
 *     user's first scroll and tap, not to a sync burst that writes hundreds of
 *     rows into IndexedDB. Only then, and only when the browser reports itself
 *     idle, does the network get touched.
 *
 * The cold start is the one caller that does not come through here at all: a
 * device that has never completed a pull has no painted library to protect, so
 * `use-library-books.ts` fills the mirror at once instead of waiting.
 */

/** Quiet time handed to the user between the library painting and any sync. */
const SETTLE_MS = 500;
/** How long a page with no library on it waits before revalidating anyway. */
const NO_LIBRARY_DEADLINE_MS = 2_000;
/** Ceiling on waiting for an idle browser, so a busy page still syncs. */
const IDLE_TIMEOUT_MS = 2_000;

let painted = false;
const waitingForPaint = new Set<() => void>();

/**
 * The library has rendered. Called from the render that sets
 * `data-launch-ready`; it never gates the render itself.
 */
export function markLaunchPainted(): void {
  if (painted) return;
  painted = true;
  const pending = [...waitingForPaint];
  waitingForPaint.clear();
  for (const release of pending) release();
}

/**
 * Runs `task` once the launch has painted and the browser has gone quiet.
 * Returns a cancel function; cancelling before `task` starts means it never
 * runs, which is what an unmounting component needs.
 */
export function afterLaunchPaint(task: () => void): () => void {
  let cancelled = false;
  let settleTimer = 0;
  let deadlineTimer = 0;
  let idleHandle: number | null = null;

  const release = () => {
    if (cancelled) return;
    window.clearTimeout(deadlineTimer);
    waitingForPaint.delete(release);
    settleTimer = window.setTimeout(() => {
      idleHandle = whenIdle(() => {
        if (!cancelled) task();
      });
    }, SETTLE_MS);
  };

  if (painted) {
    release();
  } else {
    waitingForPaint.add(release);
    // A page with no library on it — the player, settings, an auth screen —
    // has nothing to wait for, so it revalidates on its own deadline.
    deadlineTimer = window.setTimeout(release, NO_LIBRARY_DEADLINE_MS);
  }

  return () => {
    cancelled = true;
    waitingForPaint.delete(release);
    window.clearTimeout(deadlineTimer);
    window.clearTimeout(settleTimer);
    if (idleHandle !== null) cancelIdle(idleHandle);
  };
}

function whenIdle(run: () => void): number {
  if (typeof requestIdleCallback === "function") {
    return requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
  }
  return window.setTimeout(run, 0);
}

function cancelIdle(handle: number): void {
  if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}
