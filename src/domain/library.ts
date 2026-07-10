export type LibraryBook = {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  series: string | null;
  chapterDiagnostic: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  durationMs: number | null;
  positionMs: number | null;
  completed: boolean | null;
  progressUpdatedAt: string | null;
};
