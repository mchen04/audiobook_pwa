import { replayQueuedMutations } from "@/lib/offline-sync";
import { commitHistoryEvent } from "@/lib/offline/outbox";
import { getDeviceId } from "@/lib/playback-core";

const MIN_SESSION_MS = 5_000;

export type ListeningStretch = {
  startedAt: string;
  endedAt: string;
  startPositionMs: number;
  endPositionMs: number;
};

type PostSession = (bookId: string, payload: ListeningStretch) => void;

/**
 * Records contiguous listening stretches. `begin` on play, `end` on
 * pause/finish/book-switch; stretches under five seconds are dropped.
 *
 * Nothing here asks whether the network is up. It used to: an offline stretch
 * was discarded on the spot, and an online one was posted with a bare
 * `void fetch` that swallowed its own failure — so a session lost to a
 * connection that dropped mid-request was gone, silently, after the user had
 * already been shown the time as listened. Both are the same bug, and the fix
 * for both is that `post` journals rather than sends.
 */
export function createListeningTracker(post: PostSession, now: () => number = Date.now) {
  let started: { startedAtMs: number; startPositionMs: number } | null = null;

  return {
    begin(positionMs: number): void {
      if (!started) started = { startedAtMs: now(), startPositionMs: positionMs };
    },
    end(bookId: string, endPositionMs: number): void {
      const current = started;
      started = null;
      if (!current) return;
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

/**
 * The production sink: one outbox row per stretch, drained immediately.
 *
 * `history` is the mutation kind that never coalesces — its key carries a fresh
 * `mutationId` — so two stretches of the same book can never collapse into one.
 * The drain is a best-effort head start, not the delivery mechanism: whatever it
 * does not manage is still in the outbox for the next launch or reconnect.
 */
export function queueListeningSession(userId: string): PostSession {
  return (bookId, payload) => {
    void commitHistoryEvent({ userId, deviceId: getDeviceId() }, bookId, payload)
      .then(() => replayQueuedMutations(userId))
      .catch(() => undefined);
  };
}
