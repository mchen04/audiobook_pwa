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
  chapters: PlayerChapter[];
  initialPositionMs: number;
  initialPlaybackRate: number;
  completed: boolean;
};

export type NextInCollection = {
  id: string;
  title: string;
  collectionName: string;
};

export type Bookmark = {
  id: string;
  positionMs: number;
  note: string | null;
  createdAt: string;
};
