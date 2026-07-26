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
  const last = chapters[chapters.length - 1];
  if (!last) return null;
  if (currentTimeMs >= last.startMs) return last;
  // Chapters are sorted and non-overlapping, so binary-search the last one
  // starting at or before the position — this runs per timeupdate tick and
  // books can carry 10k+ chapters.
  let low = 0;
  let high = chapters.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid]!.startMs <= currentTimeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const chapter = chapters[candidate]!;
  return currentTimeMs < chapter.endMs ? chapter : null;
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

export type LocalPosition = {
  positionMs: number;
  occurredAt: number;
  /** Absent on records written before the rate and completion were durable. */
  playbackRate?: number;
  completed?: boolean;
};

/**
 * The whole durable playback tuple for one book, written SYNCHRONOUSLY.
 *
 * This is the only write in the app that a terminating page is guaranteed to
 * complete. It runs to the `setItem` with no await, no lock and no IndexedDB
 * transaction in front of it, because a `visibilitychange` or `pagehide`
 * handler on iOS gets one task and then the process may be gone: anything
 * scheduled behind `navigator.locks.request` (an asynchronous grant, not a
 * microtask) or behind an IDB transaction simply never runs.
 *
 * The rate and the completion flag travel with the position because the user's
 * request was "save the proper and necessary info": a relaunch that restores
 * the second but resets 1.6x to 1.0x has still lost their place.
 *
 * A throwing `setItem` — Safari's "Block All Cookies", a full quota — must not
 * take anything else down with it. It is contained here so the caller can go on
 * to journal the same event in the outbox, which is the other durable copy.
 */
export function saveLocalPlaybackState(
  userId: string,
  bookId: string,
  state: { positionMs: number; playbackRate?: number; completed?: boolean; occurredAt?: number },
): boolean {
  const record: LocalPosition = {
    positionMs: Math.round(state.positionMs),
    occurredAt: state.occurredAt ?? Date.now(),
  };
  if (typeof state.playbackRate === "number" && Number.isFinite(state.playbackRate)) {
    record.playbackRate = state.playbackRate;
  }
  if (typeof state.completed === "boolean") record.completed = state.completed;
  try {
    localStorage.setItem(localPositionKey(userId, bookId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function saveLocalPosition(
  userId: string,
  bookId: string,
  positionMs: number,
  occurredAt = Date.now(),
): void {
  saveLocalPlaybackState(userId, bookId, { positionMs, occurredAt });
}

export function readLocalPosition(userId: string, bookId: string): number | null {
  return readLocalProgress(userId, bookId)?.positionMs ?? null;
}

export function readLocalProgress(userId: string, bookId: string): LocalPosition | null {
  // `getItem` is inside the try, not in front of it: it throws outright when
  // the user has blocked storage, and a throw from here used to propagate
  // through `loadBook` so the book never opened at all.
  try {
    const value = localStorage.getItem(localPositionKey(userId, bookId));
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "number") return validLocalPosition(parsed, 0);
      if (parsed && typeof parsed === "object") return validLocalPosition(parsed, undefined);
    } catch {
      return validLocalPosition(Number(value), 0);
    }
    return null;
  } catch {
    return null;
  }
}

/** Every book this device holds a local position for, for the shelf projection. */
export function listLocalPlaybackStates(
  userId: string,
): Array<{ bookId: string; state: LocalPosition }> {
  const prefix = `chapterline:position:${userId}:`;
  const found: Array<{ bookId: string; state: LocalPosition }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const bookId = key.slice(prefix.length);
      const state = readLocalProgress(userId, bookId);
      if (state) found.push({ bookId, state });
    }
  } catch {
    return found;
  }
  return found;
}

/**
 * Does this device's own record describe a later moment than the server's?
 *
 * A local record with no timestamp (`occurredAt: 0`, which is every pre-v2
 * value) loses to any server timestamp: it claims no moment at all, so it
 * cannot claim a later one.
 */
export function localWinsOver(
  local: LocalPosition | null,
  serverOccurredAt: string | null,
): boolean {
  if (!local) return false;
  if (!serverOccurredAt) return true;
  const serverTime = Date.parse(serverOccurredAt);
  return !(Number.isFinite(serverTime) && serverTime > local.occurredAt);
}

export function freshestPosition(input: {
  local: LocalPosition | null;
  serverPositionMs: number;
  serverOccurredAt: string | null;
}): number {
  const { local } = input;
  return local && localWinsOver(local, input.serverOccurredAt)
    ? local.positionMs
    : input.serverPositionMs;
}

export function readMsSinceLastPause(): number | null {
  try {
    const raw = Number(localStorage.getItem(LAST_PAUSED_KEY) || 0);
    return raw > 0 ? Date.now() - raw : null;
  } catch {
    return null;
  }
}

export function markPausedNow(): void {
  try {
    localStorage.setItem(LAST_PAUSED_KEY, String(Date.now()));
  } catch {
    // A device with storage blocked still has to be able to play.
  }
}

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem("chapterline:device-id");
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem("chapterline:device-id", created);
    return created;
  } catch {
    return sessionDeviceId();
  }
}

const LAST_PAUSED_KEY = "chapterline:last-paused-at";

/**
 * One stable id for a session that cannot persist one. Minting a fresh uuid per
 * call would give every write its own device identity, and the server orders
 * progress per (user, book, device) — a new device on every write is no
 * ordering at all, and every write but the first would be discarded.
 */
let ephemeralDeviceId: string | null = null;

function sessionDeviceId(): string {
  if (!ephemeralDeviceId) ephemeralDeviceId = `ephemeral:${crypto.randomUUID()}`;
  return ephemeralDeviceId;
}

function localPositionKey(userId: string, bookId: string): string {
  return `chapterline:position:${userId}:${bookId}`;
}

function validLocalPosition(parsed: unknown, occurredAtOverride: number | undefined) {
  const entry = (
    typeof parsed === "number" ? { positionMs: parsed } : parsed
  ) as Partial<LocalPosition> | null;
  const positionMs = entry?.positionMs;
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) return null;
  const occurredAt = occurredAtOverride ?? entry?.occurredAt;
  const record: LocalPosition = {
    positionMs,
    occurredAt:
      typeof occurredAt === "number" && Number.isFinite(occurredAt) && occurredAt >= 0
        ? occurredAt
        : 0,
  };
  if (typeof entry?.playbackRate === "number" && Number.isFinite(entry.playbackRate)) {
    record.playbackRate = entry.playbackRate;
  }
  if (typeof entry?.completed === "boolean") record.completed = entry.completed;
  return record;
}
