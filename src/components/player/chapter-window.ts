export const CHAPTER_WINDOW_SIZE = 200;

export function chapterWindowStart(activeIndex: number, total: number): number {
  if (total <= CHAPTER_WINDOW_SIZE) return 0;
  const centered = Math.max(0, activeIndex - Math.floor(CHAPTER_WINDOW_SIZE / 2));
  return Math.min(centered, total - CHAPTER_WINDOW_SIZE);
}

export function chapterWindow<T>(items: T[], start: number): T[] {
  return items.slice(start, start + CHAPTER_WINDOW_SIZE);
}
