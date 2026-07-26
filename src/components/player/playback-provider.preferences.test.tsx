// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A settings toggle must send exactly one write.
 *
 * `updatePreferences` used to call `savePreferences` from INSIDE the
 * `setPreferences` updater. React is allowed to invoke an updater more than
 * once for a single call — StrictMode does it on every render — so one tap on a
 * toggle fired two PATCHes. A state updater is required to be pure; a network
 * request is the least pure thing that could be in one.
 *
 * The test therefore renders under `StrictMode` deliberately. Without it the
 * double-invoke never happens and the assertion cannot fail.
 */

const { savePreferences, fetchPreferences, readCachedPreferences, DEFAULTS } = vi.hoisted(() => ({
  savePreferences: vi.fn(),
  fetchPreferences: vi.fn(),
  readCachedPreferences: vi.fn(),
  DEFAULTS: {
    skipBackMs: 15_000,
    skipForwardMs: 30_000,
    smartRewind: true,
    autoplayNextInCollection: false,
  },
}));

vi.mock("@/lib/preferences", () => ({
  DEFAULT_PREFERENCES: DEFAULTS,
  SKIP_CHOICES_MS: [15_000, 30_000],
  savePreferences,
  fetchPreferences,
  readCachedPreferences,
}));
vi.mock("@/lib/playback-history", () => ({
  loadPlaybackHistory: vi.fn().mockResolvedValue([]),
  PLAYBACK_HISTORY_LIMIT: 50,
  replayPlaybackHistory: vi.fn().mockResolvedValue(undefined),
  storePlaybackAction: vi.fn().mockResolvedValue("stored"),
}));
vi.mock("./use-progress-persistence", () => ({
  useProgressPersistence: () => ({
    persistProgress: vi.fn().mockResolvedValue(undefined),
    onListeningTick: vi.fn(),
    markInProgress: vi.fn(),
  }),
}));
vi.mock("./use-sleep-timer", () => ({
  useSleepTimer: () => ({
    sleepMode: null,
    setSleepMinutes: vi.fn(),
    setSleepAtChapterEnd: vi.fn(),
    clearSleep: vi.fn(),
    onTimeUpdate: vi.fn(),
  }),
}));
vi.mock("./use-tab-arbitration", () => ({ useTabArbitration: () => vi.fn() }));
vi.mock("./use-media-session", () => ({
  setMediaSessionMetadata: vi.fn(),
  setMediaSessionPlaybackState: vi.fn(),
  syncMediaSessionPosition: vi.fn(),
  useMediaSession: vi.fn(),
}));

import { PlaybackProvider, usePlayback } from "./playback-provider";

function PreferencesHarness() {
  const playback = usePlayback();
  return (
    <>
      <button onClick={() => playback.updatePreferences({ skipBackMs: 45_000 })}>skip back</button>
      <button onClick={() => playback.updatePreferences({ smartRewind: false })}>rewind</button>
      <output aria-label="skip back">{playback.preferences.skipBackMs}</output>
      <output aria-label="smart rewind">{String(playback.preferences.smartRewind)}</output>
    </>
  );
}

beforeEach(() => {
  cleanup();
  savePreferences.mockReset().mockResolvedValue(undefined);
  fetchPreferences.mockReset().mockResolvedValue(DEFAULTS);
  readCachedPreferences.mockReset().mockReturnValue(DEFAULTS);
});

afterEach(() => {
  cleanup();
});

async function mount(): Promise<void> {
  render(
    <StrictMode>
      <PlaybackProvider userId="user-1">
        <PreferencesHarness />
      </PlaybackProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByLabelText("skip back")).toBeInTheDocument());
}

it("sends one write per change, even when React double-invokes the updater", async () => {
  await mount();
  savePreferences.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "skip back" }));

  await waitFor(() => expect(savePreferences).toHaveBeenCalled());
  expect(
    savePreferences.mock.calls.length,
    `one settings change produced ${savePreferences.mock.calls.length} server writes. The save is ` +
      "being made from inside a state updater, which React may run more than once.",
  ).toBe(1);
  expect(savePreferences.mock.calls[0]![2]).toStrictEqual({ skipBackMs: 45_000 });
  expect(screen.getByLabelText("skip back")).toHaveTextContent("45000");
});

it("composes two changes in the same tick instead of losing one", async () => {
  await mount();
  savePreferences.mockClear();

  fireEvent.click(screen.getByRole("button", { name: "skip back" }));
  fireEvent.click(screen.getByRole("button", { name: "rewind" }));

  await waitFor(() => expect(savePreferences).toHaveBeenCalledTimes(2));
  // Moving the save out of the updater means it no longer receives React's
  // freshest state automatically, so the second change must still see the
  // first. If it does not, one of the two settings silently reverts.
  expect(savePreferences.mock.calls[1]![1]).toMatchObject({ skipBackMs: 45_000 });
  expect(screen.getByLabelText("skip back")).toHaveTextContent("45000");
  expect(screen.getByLabelText("smart rewind")).toHaveTextContent("false");
});
