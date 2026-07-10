export type ExistingProgress = {
  eventOccurredAt: Date;
};

export type ProgressDecision = {
  accept: boolean;
  occurredAt: Date;
  reason: "accepted" | "stale-event" | "invalid-time";
};

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ORDERING_TOLERANCE_MS = 2_000;

export function decideProgressUpdate(
  existing: ExistingProgress | null,
  occurredAt: Date,
  serverNow: Date,
): ProgressDecision {
  const incomingTime = occurredAt.getTime();
  const now = serverNow.getTime();
  if (!Number.isFinite(incomingTime)) {
    return { accept: false, occurredAt: serverNow, reason: "invalid-time" };
  }

  const bounded = new Date(Math.min(incomingTime, now + MAX_FUTURE_SKEW_MS));
  if (existing && bounded.getTime() + ORDERING_TOLERANCE_MS < existing.eventOccurredAt.getTime()) {
    return { accept: false, occurredAt: bounded, reason: "stale-event" };
  }

  return { accept: true, occurredAt: bounded, reason: "accepted" };
}
