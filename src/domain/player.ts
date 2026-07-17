export type PlayerChapter = {
  id: string;
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

export type PlayerBook = {
  id: string;
  title: string;
  author: string;
  durationMs: number;
  mediaUrl: string;
  coverUrl: string | null;
  /** Downscaled cover for small surfaces; absent on older stored books. */
  coverThumbUrl?: string | null;
  chapters: PlayerChapter[];
  initialPositionMs: number;
  initialProgressOccurredAt: string | null;
  initialPlaybackRate: number;
  completed: boolean;
};

export type NextInCollection = {
  id: string;
  title: string;
  collectionName: string;
};

export { PLAYBACK_ACTIONS, PLAYBACK_HISTORY_LIMIT } from "./playback-history";
export type {
  PlaybackAction,
  PlaybackHistoryEntry,
  PlaybackHistorySnapshot,
} from "./playback-history";
