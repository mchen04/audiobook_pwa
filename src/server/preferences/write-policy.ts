import { PREFERENCES_DEFAULTS_VERSION, type PlayerPreferences } from "@/domain/preferences";

export type PreferenceWritePolicy = {
  patch: Partial<PlayerPreferences>;
  smartRewindExplicit?: boolean;
};

/**
 * Pre-v2 clients inherited smart rewind as enabled and cannot prove that true
 * was an explicit choice. During rollout they may still wake from an installed
 * service-worker shell and replay a full cached object after the database
 * migration ran. The database trigger owns legacy transition policy because
 * it also protects predecessor server instances. Current clients identify
 * themselves in an HTTP header that predecessor servers safely ignore,
 * keeping rollback and mixed-version writes body-compatible.
 */
export function applyPreferenceWritePolicy(
  request: Partial<PlayerPreferences>,
  defaultsVersionHeader: string | null,
): PreferenceWritePolicy {
  const patch = { ...request };
  if (patch.smartRewind === undefined) return { patch };
  if (defaultsVersionHeader !== String(PREFERENCES_DEFAULTS_VERSION)) return { patch };
  return { patch, smartRewindExplicit: patch.smartRewind };
}

/** Only provenance-backed true is visible to readers during rolling upgrades. */
export function resolveSmartRewind(
  row: Pick<PlayerPreferences, "smartRewind"> & { smartRewindExplicit: boolean },
): boolean {
  return row.smartRewindExplicit && row.smartRewind;
}

export function serializePlayerPreferences(
  row: PlayerPreferences & { smartRewindExplicit: boolean },
): PlayerPreferences {
  return {
    skipBackMs: row.skipBackMs,
    skipForwardMs: row.skipForwardMs,
    smartRewind: resolveSmartRewind(row),
    autoplayNextInCollection: row.autoplayNextInCollection,
  };
}
