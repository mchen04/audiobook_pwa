// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";

const { playback } = vi.hoisted(() => ({
  playback: {
    userId: "user-1",
    book: null,
    currentTimeMs: 5_000,
    isPlaying: false,
    playbackRate: 1,
    history: [],
    historyNotice: null,
    currentChapter: null as {
      id: string;
      position: number;
      title: string;
      startMs: number;
      endMs: number;
    } | null,
    sleepMode: null,
    preferences: {
      skipBackMs: 15_000,
      skipForwardMs: 30_000,
      smartRewind: true,
      autoplayNextInCollection: false,
    },
    lastEndedAt: 0,
    updatePreferences: vi.fn(),
    loadBook: vi.fn(),
    toggle: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    restoreHistoryPosition: vi.fn(),
    moveToChapter: vi.fn(),
    skip: vi.fn(),
    setPlaybackRate: vi.fn(),
    setSleepMinutes: vi.fn(),
    setSleepAtChapterEnd: vi.fn(),
    clearSleep: vi.fn(),
    markFinished: vi.fn(),
    restart: vi.fn(),
    unloadBook: vi.fn(),
  },
}));

vi.mock("./playback-provider", () => ({ usePlayback: () => playback }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { FullPlayer } from "./full-player";

const playerBook: PlayerBook = {
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
const emptyHistorySnapshot = { entries: [], capturedAt: "2026-07-12T18:30:00.000Z" };

describe("full player history wiring", () => {
  beforeEach(() => {
    for (const value of Object.values(playback)) {
      if (typeof value === "function" && "mockClear" in value) value.mockClear();
    }
    playback.currentChapter = playerBook.chapters[0]!;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("routes every visible playback control through the recorded provider actions", () => {
    const { rerender } = render(
      <FullPlayer playerBook={playerBook} historySnapshot={emptyHistorySnapshot} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back 15 seconds" }));
    expect(playback.skip).toHaveBeenCalledWith(-15_000);
    fireEvent.click(screen.getByRole("button", { name: "Forward 30 seconds" }));
    expect(playback.skip).toHaveBeenCalledWith(30_000);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(playback.toggle).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Audiobook position" }), {
      target: { value: "12000" },
    });
    expect(playback.seek).toHaveBeenCalledWith(12_000);
    fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), {
      target: { value: "1.5" },
    });
    expect(playback.setPlaybackRate).toHaveBeenCalledWith(1.5);
    fireEvent.click(screen.getByRole("button", { name: "Next chapter" }));
    expect(playback.moveToChapter).toHaveBeenCalledWith(playerBook.chapters[1], "next");

    playback.currentChapter = playerBook.chapters[1]!;
    rerender(<FullPlayer playerBook={playerBook} historySnapshot={emptyHistorySnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous chapter" }));
    expect(playback.moveToChapter).toHaveBeenCalledWith(playerBook.chapters[0], "previous");

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog", { name: "Playback history" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });
});
