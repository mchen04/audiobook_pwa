/**
 * The isomorphic core of player preferences: the shape, the product defaults,
 * and the wire protocol constants. Both sides of the API import from here —
 * the browser cache/replay logic in `@/lib/preferences` and the server route,
 * schema, and write policy — so neither drags the other's runtime along.
 */

export type PlayerPreferences = {
  skipBackMs: number;
  skipForwardMs: number;
  smartRewind: boolean;
  autoplayNextInCollection: boolean;
};

export const DEFAULT_PREFERENCES: PlayerPreferences = {
  skipBackMs: 15_000,
  skipForwardMs: 30_000,
  // Exact resume is the safe default. Smart rewind is still available, but a
  // returning listener must opt in before opening a book can move behind the
  // durable position they actually reached.
  smartRewind: false,
  autoplayNextInCollection: false,
};

export const SKIP_CHOICES_MS = [5_000, 10_000, 15_000, 30_000, 45_000, 60_000, 90_000];
export const PREFERENCES_DEFAULTS_VERSION = 2;
export const PREFERENCES_DEFAULTS_HEADER = "X-Chapterline-Preferences-Defaults-Version";
export const PREFERENCES_WRITE_ID_HEADER = "X-Chapterline-Preferences-Write-Id";
export const PREFERENCES_LEGACY_REPLAY_HEADER = "X-Chapterline-Preferences-Legacy-Replay";
const PREFERENCES_WRITE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPreferenceWriteId(value: unknown): value is string {
  return typeof value === "string" && PREFERENCES_WRITE_ID_PATTERN.test(value);
}

/** Shared skip bounds: client normalizer, API schema, and the database check
 * constraints in `db/schema.ts` all enforce this same range. */
export const SKIP_BOUNDS_MS = { min: 5_000, max: 120_000 } as const;
