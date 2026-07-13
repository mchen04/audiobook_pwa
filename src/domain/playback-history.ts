export const PLAYBACK_HISTORY_LIMIT = 50;

export const PLAYBACK_ACTIONS = [
  "opened",
  "play",
  "pause",
  "seek",
  "skip_back",
  "skip_forward",
  "previous_chapter",
  "next_chapter",
  "playback_rate",
  "sleep_timer",
  "sleep_timer_cleared",
  "finished",
  "restarted",
  "history_restore",
] as const;

export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

export type PlaybackHistoryEntry = {
  id: string;
  action: PlaybackAction;
  positionMs: number;
  previousPositionMs: number | null;
  playbackRate: number;
  description: string | null;
  occurredAt: string;
  recordedAt: string;
};

export type PlaybackHistorySnapshot = {
  entries: PlaybackHistoryEntry[];
  capturedAt: string;
};
