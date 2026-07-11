import type { PlayerChapter } from "@/domain/player";

/** How close to a boundary counts as "at" it, in milliseconds. */
export const CHAPTER_END_EPSILON_MS = 350;
export const BOOK_END_EPSILON_MS = 1_000;

/**
 * The chapter containing a position. Positions at or past the last chapter's
 * start (including the sliver between its endMs and the audio's true duration)
 * belong to the final chapter so chapter navigation keeps working at the end.
 */
export function selectCurrentChapter(
  chapters: PlayerChapter[],
  currentTimeMs: number,
): PlayerChapter | null {
  const within = chapters.find(
    (chapter) => currentTimeMs >= chapter.startMs && currentTimeMs < chapter.endMs,
  );
  if (within) return within;
  const last = chapters[chapters.length - 1];
  return last && currentTimeMs >= last.startMs ? last : null;
}

/** Bounded smart-rewind for time spent away from the book. */
export function rewindForAbsence(absenceMs: number): number {
  if (!Number.isFinite(absenceMs) || absenceMs < 60_000) return 0;
  if (absenceMs < 10 * 60_000) return 5_000;
  if (absenceMs < 60 * 60_000) return 15_000;
  return 30_000;
}

/**
 * Where playback should begin for a stored position. A book stored at its very
 * end restarts from the beginning; otherwise smart rewind (when enabled and a
 * pause marker exists) backs up a bounded amount.
 */
export function resolveStartPosition(input: {
  storedPositionMs: number;
  durationMs: number;
  smartRewindEnabled: boolean;
  msSinceLastPause: number | null;
}): { startAtMs: number; appliedRewindMs: number } {
  if (input.storedPositionMs >= input.durationMs - BOOK_END_EPSILON_MS) {
    return { startAtMs: 0, appliedRewindMs: 0 };
  }
  const appliedRewindMs =
    input.smartRewindEnabled && input.msSinceLastPause !== null
      ? rewindForAbsence(input.msSinceLastPause)
      : 0;
  return { startAtMs: Math.max(0, input.storedPositionMs - appliedRewindMs), appliedRewindMs };
}

export function isChapterEnding(chapter: PlayerChapter, positionMs: number): boolean {
  return chapter.endMs - positionMs <= CHAPTER_END_EPSILON_MS;
}

/* Per-user local playback state. Keys are user-scoped so account switches on
 * one device never leak positions between accounts. */

export type LocalPosition = { positionMs: number; occurredAt: number };

export function saveLocalPosition(
  userId: string,
  bookId: string,
  positionMs: number,
  occurredAt = Date.now(),
): void {
  localStorage.setItem(
    localPositionKey(userId, bookId),
    JSON.stringify({ positionMs: Math.round(positionMs), occurredAt }),
  );
}

export function readLocalPosition(userId: string, bookId: string): number | null {
  return readLocalProgress(userId, bookId)?.positionMs ?? null;
}

export function readLocalProgress(userId: string, bookId: string): LocalPosition | null {
  const value = localStorage.getItem(localPositionKey(userId, bookId));
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "number") return validLocalPosition(parsed, 0);
    if (parsed && typeof parsed === "object") {
      const entry = parsed as Partial<LocalPosition>;
      return validLocalPosition(entry.positionMs, entry.occurredAt);
    }
  } catch {
    return validLocalPosition(Number(value), 0);
  }
  return null;
}

export function freshestPosition(input: {
  local: LocalPosition | null;
  serverPositionMs: number;
  serverOccurredAt: string | null;
}): number {
  if (!input.local) return input.serverPositionMs;
  if (!input.serverOccurredAt) return input.local.positionMs;
  const serverTime = Date.parse(input.serverOccurredAt);
  return Number.isFinite(serverTime) && serverTime > input.local.occurredAt
    ? input.serverPositionMs
    : input.local.positionMs;
}

export function readMsSinceLastPause(): number | null {
  const raw = Number(localStorage.getItem(LAST_PAUSED_KEY) || 0);
  return raw > 0 ? Date.now() - raw : null;
}

export function markPausedNow(): void {
  localStorage.setItem(LAST_PAUSED_KEY, String(Date.now()));
}

export function getDeviceId(): string {
  const existing = localStorage.getItem("chapterline:device-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem("chapterline:device-id", created);
  return created;
}

const LAST_PAUSED_KEY = "chapterline:last-paused-at";

function localPositionKey(userId: string, bookId: string): string {
  return `chapterline:position:${userId}:${bookId}`;
}

function validLocalPosition(positionMs: unknown, occurredAt: unknown): LocalPosition | null {
  return typeof positionMs === "number" && Number.isFinite(positionMs) && positionMs >= 0
    ? {
        positionMs,
        occurredAt:
          typeof occurredAt === "number" && Number.isFinite(occurredAt) && occurredAt >= 0
            ? occurredAt
            : 0,
      }
    : null;
}
