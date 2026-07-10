const MIN_SESSION_MS = 5_000;

type PostSession = (
  bookId: string,
  payload: {
    startedAt: string;
    endedAt: string;
    startPositionMs: number;
    endPositionMs: number;
  },
) => void;

/**
 * Records contiguous listening stretches. `begin` on play, `end` on
 * pause/finish/book-switch; stretches under five seconds are dropped and
 * offline stretches are skipped (history is a nicety, not queued state).
 */
export function createListeningTracker(
  post: PostSession = defaultPost,
  now: () => number = Date.now,
  isOnline: () => boolean = () => navigator.onLine,
) {
  let started: { startedAtMs: number; startPositionMs: number } | null = null;

  return {
    begin(positionMs: number): void {
      if (!started) started = { startedAtMs: now(), startPositionMs: positionMs };
    },
    end(bookId: string, endPositionMs: number): void {
      const current = started;
      started = null;
      if (!current || !isOnline()) return;
      const endedAtMs = now();
      if (endedAtMs - current.startedAtMs < MIN_SESSION_MS) return;
      post(bookId, {
        startedAt: new Date(current.startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        startPositionMs: Math.round(current.startPositionMs),
        endPositionMs: Math.round(endPositionMs),
      });
    },
    reset(): void {
      started = null;
    },
  };
}

function defaultPost(bookId: string, payload: Parameters<PostSession>[1]): void {
  void fetch(`/api/books/${bookId}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}
