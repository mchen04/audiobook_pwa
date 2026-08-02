"use client";

import {
  createContext,
  ReactNode,
  RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DEFAULT_PREFERENCES, type PlayerPreferences } from "@/domain/preferences";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { fetchPreferences, readCachedPreferences, savePreferences } from "@/lib/preferences";

type PreferencesContextValue = {
  preferences: PlayerPreferences;
  updatePreferences: (patch: Partial<PlayerPreferences>) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * The ref rides in its own context so the playback machinery — smart rewind on
 * `loadBook`, the media-session skip handlers — can read the current
 * preferences at call time WITHOUT subscribing: a settings toggle must not
 * re-render every `usePlayback()` consumer. The fallback means a
 * `PlaybackProvider` mounted without a `PreferencesProvider` (component tests
 * do this) simply reads the defaults.
 */
// Frozen: this object is shared by every tree mounted without a provider, so
// a write through it would leak across all of them.
const FALLBACK_PREFERENCES_REF: RefObject<PlayerPreferences> = Object.freeze({
  current: DEFAULT_PREFERENCES,
});
const PreferencesRefContext = createContext<RefObject<PlayerPreferences>>(FALLBACK_PREFERENCES_REF);

export function PreferencesProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const preferencesRef = useRef<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetchPreferences(userId)
        .then((fresh) => {
          if (active) setPreferences(fresh);
        })
        .catch(() => undefined);
    };
    // This device's own answer is applied at once; the server's is revalidation
    // and waits for the launch to paint. `fetchPreferences` used to fire from
    // mount, which put a network round trip and a Postgres query in front of
    // the frame the launch is measured on for every page carrying the player.
    void Promise.resolve()
      .then(() => {
        if (active) setPreferences(readCachedPreferences(userId));
      })
      .catch(() => undefined);
    const cancelRevalidation = afterLaunchPaint(refresh);
    window.addEventListener("online", refresh);
    return () => {
      active = false;
      cancelRevalidation();
      window.removeEventListener("online", refresh);
    };
  }, [userId]);

  const updatePreferences = useCallback(
    (patch: Partial<PlayerPreferences>) => {
      // The save is deliberately OUTSIDE the state updater. React may invoke
      // an updater more than once for a single call — StrictMode does it on
      // every render in development — so a PATCH fired from inside one is
      // sent twice, and a state updater is required to be pure regardless.
      // The ref is written here rather than left to its effect so two
      // updates in the same tick still compose.
      const current = preferencesRef.current;
      const next = { ...current, ...patch };
      preferencesRef.current = next;
      setPreferences(next);
      void savePreferences(userId, current, patch);
    },
    [userId],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({ preferences, updatePreferences }),
    [preferences, updatePreferences],
  );

  return (
    <PreferencesContext.Provider value={value}>
      <PreferencesRefContext.Provider value={preferencesRef}>
        {children}
      </PreferencesRefContext.Provider>
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used inside PreferencesProvider");
  return context;
}

/** Read-at-call-time handle for code that must not re-render on a toggle. */
export function usePreferencesRef(): RefObject<PlayerPreferences> {
  return useContext(PreferencesRefContext);
}
