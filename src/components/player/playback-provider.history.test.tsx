// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybackHistoryEntry, PlayerBook } from "@/domain/player";

const { loadPlaybackHistory, storePlaybackAction } = vi.hoisted(() => ({
  loadPlaybackHistory: vi.fn(),
  storePlaybackAction: vi.fn(),
}));

vi.mock("@/lib/playback-history", () => ({
  loadPlaybackHistory,
  PLAYBACK_HISTORY_LIMIT: 50,
  replayPlaybackHistory: vi.fn().mockResolvedValue(undefined),
  storePlaybackAction,
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

const book: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 60_000,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [
    { id: "one", position: 0, title: "One", startMs: 0, endMs: 30_000 },
    { id: "two", position: 1, title: "Two", startMs: 30_000, endMs: 60_000 },
  ],
  initialPositionMs: 5_000,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};

const hydratedEntry: PlaybackHistoryEntry = {
  id: "server-action",
  action: "pause",
  positionMs: 9_000,
  previousPositionMs: null,
  playbackRate: 1,
  description: null,
  occurredAt: "2026-07-12T18:30:00.000Z",
  recordedAt: "2026-07-12T18:30:01.000Z",
};
const hydratedSnapshot = {
  entries: [hydratedEntry],
  capturedAt: "2026-07-12T18:31:00.000Z",
};

function HistoryHarness() {
  const playback = usePlayback();
  const { loadBook } = playback;
  useEffect(() => loadBook(book), [loadBook]);
  return (
    <>
      <button onClick={playback.toggle}>toggle</button>
      <button onClick={playback.pause}>pause</button>
      <button onClick={() => playback.seek(10_000)}>seek</button>
      <button onClick={() => playback.skip(-5_000)}>skip back</button>
      <button onClick={() => playback.skip(5_000)}>skip forward</button>
      <button onClick={() => playback.moveToChapter(book.chapters[0]!, "previous")}>
        previous
      </button>
      <button onClick={() => playback.moveToChapter(book.chapters[1]!, "next")}>next</button>
      <button onClick={() => playback.setPlaybackRate(1.5)}>rate</button>
      <button onClick={() => playback.setSleepMinutes(15)}>sleep minutes</button>
      <button onClick={playback.setSleepAtChapterEnd}>sleep chapter</button>
      <button onClick={playback.clearSleep}>clear sleep</button>
      <button onClick={playback.markFinished}>finish</button>
      <button onClick={playback.restart}>restart</button>
      <button onClick={() => playback.restoreHistoryPosition(12_000)}>restore</button>
      <button onClick={() => playback.loadBook(book, false, hydratedSnapshot)}>hydrate</button>
      <output>{playback.historyNotice}</output>
      <output aria-label="history entries">
        {playback.history.map((entry) => entry.id).join(",")}
      </output>
    </>
  );
}

describe("playback action capture", () => {
  let mediaPaused = true;

  beforeEach(() => {
    mediaPaused = true;
    loadPlaybackHistory
      .mockReset()
      .mockImplementation(async (_userId, _bookId, snapshot) => snapshot?.entries || []);
    storePlaybackAction.mockReset().mockResolvedValue("stored");
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => mediaPaused);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      if (mediaPaused) {
        mediaPaused = false;
        this.dispatchEvent(new Event("play"));
      }
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      if (!mediaPaused) {
        mediaPaused = true;
        this.dispatchEvent(new Event("pause"));
      }
    });
  });

  afterEach(cleanup);

  it("records every action exposed by the audiobook player", async () => {
    render(
      <PlaybackProvider userId="user-1">
        <HistoryHarness />
      </PlaybackProvider>,
    );
    await waitFor(() => expect(storePlaybackAction).toHaveBeenCalled());
    expect(storePlaybackAction.mock.calls[0]![2]).toMatchObject({
      action: "opened",
      positionMs: 5_000,
      previousPositionMs: null,
      description: null,
    });
    storePlaybackAction.mockClear();

    const expected = [
      ["toggle", "play", 5_000, null, null],
      ["pause", "pause", 5_000, null, null],
      ["seek", "seek", 10_000, 5_000, null],
      ["skip back", "skip_back", 5_000, 10_000, "5 seconds"],
      ["skip forward", "skip_forward", 10_000, 5_000, "5 seconds"],
      ["previous", "previous_chapter", 0, 10_000, "One"],
      ["next", "next_chapter", 30_000, 0, "Two"],
      ["rate", "playback_rate", 30_000, null, "1.5×"],
      ["sleep minutes", "sleep_timer", 30_000, null, "15 minutes"],
      ["sleep chapter", "sleep_timer", 30_000, null, "End of chapter"],
      ["clear sleep", "sleep_timer_cleared", 30_000, null, null],
      ["finish", "finished", 60_000, null, null],
      ["restart", "restarted", 0, 60_000, null],
      ["restore", "history_restore", 12_000, 0, null],
    ] as const;
    for (const [
      index,
      [name, action, positionMs, previousPositionMs, description],
    ] of expected.entries()) {
      fireEvent.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(storePlaybackAction).toHaveBeenCalledTimes(index + 1));
      const entry = storePlaybackAction.mock.calls.at(-1)![2];
      expect(entry).toMatchObject({ action, positionMs, previousPositionMs, description });
    }

    expect(storePlaybackAction.mock.calls.map((call) => call[2].action)).toEqual(
      expected.map(([, action]) => action),
    );
  });

  it("reconciles server history when the active book is loaded again", async () => {
    render(
      <PlaybackProvider userId="user-1">
        <HistoryHarness />
      </PlaybackProvider>,
    );
    await waitFor(() => expect(storePlaybackAction).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "hydrate" }));

    await waitFor(() =>
      expect(screen.getByLabelText("history entries")).toHaveTextContent("server-action"),
    );
    expect(loadPlaybackHistory).toHaveBeenCalledWith("user-1", "book-1", hydratedSnapshot);
  });

  it("removes phantom entries and surfaces unavailable local history storage", async () => {
    storePlaybackAction.mockResolvedValue("unavailable");
    render(
      <PlaybackProvider userId="user-1">
        <HistoryHarness />
      </PlaybackProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Playback history is unavailable on this device.")).toBeTruthy(),
    );
  });
});
