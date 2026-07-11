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
const activePreferenceWrites = new Map<string, Promise<void>>();

type CachedPreferences = {
  preferences: PlayerPreferences;
  revision: number;
  pendingRevision: number | null;
};

/** Cached copy keeps the player configured offline and on first paint. */
export function readCachedPreferences(userId: string): PlayerPreferences {
  return readCache(userId).preferences;
}

function readCache(userId: string): CachedPreferences {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return { preferences: DEFAULT_PREFERENCES, revision: 0, pendingRevision: null };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "preferences" in parsed) {
      const envelope = parsed as Partial<CachedPreferences>;
      return {
        preferences: normalize(envelope.preferences),
        revision:
          typeof envelope.revision === "number" && Number.isFinite(envelope.revision)
            ? envelope.revision
            : 0,
        pendingRevision:
          typeof envelope.pendingRevision === "number" && Number.isFinite(envelope.pendingRevision)
            ? envelope.pendingRevision
            : null,
      };
    }
    return { preferences: normalize(parsed), revision: 0, pendingRevision: null };
  } catch {
    return { preferences: DEFAULT_PREFERENCES, revision: 0, pendingRevision: null };
  }
}

function cachePreferences(userId: string, cached: CachedPreferences): void {
  localStorage.setItem(cacheKey(userId), JSON.stringify(cached));
}

export async function fetchPreferences(userId: string): Promise<PlayerPreferences> {
  const cached = readCache(userId);
  if (cached.pendingRevision !== null) {
    await enqueuePreferenceWrite(userId, cached.preferences, cached.pendingRevision).catch(
      () => undefined,
    );
    if (readCache(userId).pendingRevision !== null) return readCache(userId).preferences;
  }
  try {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error("Preferences could not be loaded.");
    const payload = (await response.json()) as { preferences: unknown };
    const preferences = normalize(payload.preferences);
    const latest = readCache(userId);
    if (latest.pendingRevision === null) {
      cachePreferences(userId, { preferences, revision: latest.revision, pendingRevision: null });
      return preferences;
    }
    return latest.preferences;
  } catch {
    return readCache(userId).preferences;
  }
}

/** Applies the change locally first; the server write happens in the background. */
export async function savePreferences(
  userId: string,
  current: PlayerPreferences,
  patch: Partial<PlayerPreferences>,
): Promise<PlayerPreferences> {
  const next = normalize({ ...current, ...patch });
  const revision = readCache(userId).revision + 1;
  cachePreferences(userId, { preferences: next, revision, pendingRevision: revision });
  await enqueuePreferenceWrite(userId, next, revision).catch(() => undefined);
  return next;
}

function enqueuePreferenceWrite(
  userId: string,
  preferences: PlayerPreferences,
  revision: number,
): Promise<void> {
  const previous = activePreferenceWrites.get(userId) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const response = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      if (!response.ok) throw new Error("Preferences could not be saved.");
      const latest = readCache(userId);
      if (latest.pendingRevision === revision) {
        cachePreferences(userId, { ...latest, pendingRevision: null });
      }
    })
    .finally(() => {
      if (activePreferenceWrites.get(userId) === next) activePreferenceWrites.delete(userId);
    });
  activePreferenceWrites.set(userId, next);
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
