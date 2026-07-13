export function playbackHistoryLockKey(userId: string, bookId: string): string {
  return `${userId}:${bookId}`;
}
