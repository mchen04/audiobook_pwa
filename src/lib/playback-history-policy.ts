export const MAX_PLAYBACK_ACTION_CLOCK_LEAD_MS = 5 * 60_000;

export function isReasonablePlaybackActionTime(occurredAt: Date, now = Date.now()): boolean {
  return occurredAt.getTime() <= now + MAX_PLAYBACK_ACTION_CLOCK_LEAD_MS;
}
