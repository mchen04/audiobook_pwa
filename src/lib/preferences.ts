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
const armedReconnectRetries = new Map<string, () => void>();

type CachedPreferences = {
  preferences: PlayerPreferences;
  revision: number;
  pendingRevision: number | null;
  /** When the still-unacknowledged revision was written on this device. */
  pendingSince: number;
};

/**
 * A preference change this device made that the server has not acknowledged.
 *
 * Preferences are the one mirrored entity (`docs/local-first.md` section 2)
 * whose write is NOT an outbox row, so nothing else on the device knows it is
 * outstanding. Sign-out purges the cache key that holds it, which made it the
 * one user write this product could destroy silently. It is surfaced here so
 * the sign-out drain can try to deliver it, and report it if it cannot.
 */
export type PendingPreferenceWrite = {
  kind: "preferences";
  entityId: string;
  queuedAt: number;
};

/** Cached copy keeps the player configured offline and on first paint. */
export function readCachedPreferences(userId: string): PlayerPreferences {
  return readCache(userId).preferences;
}

const EMPTY_CACHE: CachedPreferences = {
  preferences: DEFAULT_PREFERENCES,
  revision: 0,
  pendingRevision: null,
  pendingSince: 0,
};

function readCache(userId: string): CachedPreferences {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    if (!raw) return EMPTY_CACHE;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "preferences" in parsed) {
      const envelope = parsed as Partial<CachedPreferences>;
      return {
        preferences: normalize(envelope.preferences),
        revision: finiteOr(envelope.revision, 0),
        pendingRevision:
          typeof envelope.pendingRevision === "number" && Number.isFinite(envelope.pendingRevision)
            ? envelope.pendingRevision
            : null,
        pendingSince: finiteOr(envelope.pendingSince, 0),
      };
    }
    return { ...EMPTY_CACHE, preferences: normalize(parsed) };
  } catch {
    return EMPTY_CACHE;
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cachePreferences(userId: string, cached: CachedPreferences): void {
  localStorage.setItem(cacheKey(userId), JSON.stringify(cached));
}

export async function fetchPreferences(userId: string): Promise<PlayerPreferences> {
  await flushPendingPreferences(userId);
  const before = readCache(userId);
  if (before.pendingRevision !== null) return before.preferences;
  try {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    if (!response.ok) throw new Error("Preferences could not be loaded.");
    const payload = (await response.json()) as { preferences: unknown };
    const preferences = normalize(payload.preferences);
    const latest = readCache(userId);
    // The server's answer is adopted only if this device has written nothing
    // since the GET was issued. `pendingRevision === null` is not enough on its
    // own: a write that started AND was acknowledged while the GET was in
    // flight leaves no pending flag behind, and the body now in hand predates
    // it. The revision counter is what makes that case visible.
    if (latest.pendingRevision === null && latest.revision === before.revision) {
      cachePreferences(userId, { ...latest, preferences });
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
  cachePreferences(userId, {
    preferences: next,
    revision,
    pendingRevision: revision,
    pendingSince: Date.now(),
  });
  await enqueuePreferenceWrite(userId, next, revision).catch(() => undefined);
  armReconnectRetry(userId);
  return next;
}

/**
 * Re-sends the unacknowledged revision, if there is one. Safe to call at any
 * time: it joins the same per-user chain every other write uses, so it can
 * never race a save into the wrong order, and it is a no-op when nothing is
 * outstanding.
 */
export async function flushPendingPreferences(
  userId: string,
  fetchFn?: typeof fetch,
): Promise<void> {
  const cached = readCache(userId);
  if (cached.pendingRevision === null) return;
  await enqueuePreferenceWrite(userId, cached.preferences, cached.pendingRevision, fetchFn).catch(
    () => undefined,
  );
  armReconnectRetry(userId);
}

/** The outstanding preference write, in the shape the sign-out report uses. */
export function listPendingPreferenceWrites(userId: string): PendingPreferenceWrite[] {
  const cached = readCache(userId);
  if (cached.pendingRevision === null) return [];
  return [{ kind: "preferences", entityId: userId, queuedAt: cached.pendingSince }];
}

/**
 * Heals a dropped PATCH on reconnect rather than waiting for the next app
 * open. Without this the only retry was `fetchPreferences` at launch, so a
 * failed write survived only as long as the tab did — and a sign-out in
 * between destroyed it, because `clearLocalDataForUser` removes the cache key
 * that is the write's sole record.
 *
 * The listener detaches itself as soon as nothing is outstanding, which also
 * covers the account being purged: the key is gone, so there is no pending
 * revision, so the retry retires.
 */
function armReconnectRetry(userId: string): void {
  if (typeof window === "undefined") return;
  if (readCache(userId).pendingRevision === null) {
    disarmReconnectRetry(userId);
    return;
  }
  if (armedReconnectRetries.has(userId)) return;
  const retry = () => {
    void flushPendingPreferences(userId);
  };
  armedReconnectRetries.set(userId, retry);
  window.addEventListener("online", retry);
}

function disarmReconnectRetry(userId: string): void {
  const retry = armedReconnectRetries.get(userId);
  if (!retry) return;
  armedReconnectRetries.delete(userId);
  window.removeEventListener("online", retry);
}

function enqueuePreferenceWrite(
  userId: string,
  preferences: PlayerPreferences,
  revision: number,
  fetchFn?: typeof fetch,
): Promise<void> {
  const previous = activePreferenceWrites.get(userId) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const send = fetchFn ?? fetch;
      const response = await send("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      if (!response.ok) throw new Error("Preferences could not be saved.");
      const latest = readCache(userId);
      if (latest.pendingRevision === revision) {
        cachePreferences(userId, { ...latest, pendingRevision: null, pendingSince: 0 });
        disarmReconnectRetry(userId);
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
