const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MIN_SESSION_MS = 5_000;
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

export function isValidListeningSession(input: {
  startedAt: Date;
  endedAt: Date;
  startPositionMs: number;
  endPositionMs: number;
  durationMs: number;
  now?: Date;
}): boolean {
  const now = input.now || new Date();
  const listenedMs = input.endedAt.getTime() - input.startedAt.getTime();
  return (
    Number.isSafeInteger(input.startPositionMs) &&
    Number.isSafeInteger(input.endPositionMs) &&
    input.startPositionMs >= 0 &&
    input.endPositionMs >= 0 &&
    input.startPositionMs <= input.durationMs &&
    input.endPositionMs <= input.durationMs &&
    listenedMs >= MIN_SESSION_MS &&
    listenedMs <= MAX_SESSION_MS &&
    input.startedAt.getTime() <= now.getTime() + MAX_CLOCK_SKEW_MS &&
    input.endedAt.getTime() <= now.getTime() + MAX_CLOCK_SKEW_MS
  );
}
