/**
 * The playback position ticks at timeupdate frequency (4–60 Hz). It lives in
 * this tiny external store instead of React state so the ticking clock never
 * re-renders the player tree; only usePlaybackTime subscribers update.
 */
export type PlaybackTimeStore = {
  subscribe: (onChange: () => void) => () => void;
  read: () => number;
  write: (positionMs: number) => void;
};

export function createTimeStore(): PlaybackTimeStore {
  let timeMs = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read: () => timeMs,
    write(positionMs) {
      if (positionMs === timeMs) return;
      timeMs = positionMs;
      listeners.forEach((listener) => listener());
    },
  };
}
