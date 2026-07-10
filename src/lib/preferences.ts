export type PlayerPreferences = {
  skipBackMs: number;
  skipForwardMs: number;
  smartRewind: boolean;
  autoplayNextInCollection: boolean;
};

export const DEFAULT_PREFERENCES: PlayerPreferences = {
  skipBackMs: 15_000,
  skipForwardMs: 30_000,
  smartRewind: true,
  autoplayNextInCollection: false,
};

export const SKIP_CHOICES_MS = [5_000, 10_000, 15_000, 30_000, 45_000, 60_000, 90_000];

/** Shared skip bounds: client normalizer, API schema, and the database check
 * constraints in `db/schema.ts` all enforce this same range. */
export const SKIP_BOUNDS_MS = { min: 5_000, max: 120_000 } as const;

/** Cached copy keeps the player configured offline and on first paint. */
export function readCachedPreferences(userId: string): PlayerPreferences {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return DEFAULT_PREFERENCES;
    return normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function cachePreferences(userId: string, preferences: PlayerPreferences): void {
  localStorage.setItem(cacheKey(userId), JSON.stringify(preferences));
}

export async function fetchPreferences(userId: string): Promise<PlayerPreferences> {
  const response = await fetch("/api/preferences", { cache: "no-store" });
  if (!response.ok) throw new Error("Preferences could not be loaded.");
  const payload = (await response.json()) as { preferences: unknown };
  const preferences = normalize(payload.preferences);
  cachePreferences(userId, preferences);
  return preferences;
}

/** Applies the change locally first; the server write happens in the background. */
export async function savePreferences(
  userId: string,
  current: PlayerPreferences,
  patch: Partial<PlayerPreferences>,
): Promise<PlayerPreferences> {
  const next = normalize({ ...current, ...patch });
  cachePreferences(userId, next);
  try {
    await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    // Offline: the cached copy is authoritative until the next online load.
  }
  return next;
}

function normalize(value: unknown): PlayerPreferences {
  const raw = (value ?? {}) as Partial<PlayerPreferences>;
  return {
    skipBackMs: boundSkip(raw.skipBackMs, DEFAULT_PREFERENCES.skipBackMs),
    skipForwardMs: boundSkip(raw.skipForwardMs, DEFAULT_PREFERENCES.skipForwardMs),
    smartRewind:
      typeof raw.smartRewind === "boolean" ? raw.smartRewind : DEFAULT_PREFERENCES.smartRewind,
    autoplayNextInCollection:
      typeof raw.autoplayNextInCollection === "boolean"
        ? raw.autoplayNextInCollection
        : DEFAULT_PREFERENCES.autoplayNextInCollection,
  };
}

function boundSkip(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(SKIP_BOUNDS_MS.max, Math.max(SKIP_BOUNDS_MS.min, Math.round(value)))
    : fallback;
}

function cacheKey(userId: string): string {
  return `chapterline:preferences:${userId}`;
}
