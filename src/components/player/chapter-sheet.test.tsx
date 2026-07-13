// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PlaybackHistoryEntry, PlayerChapter } from "@/domain/player";

import { PlayerSheet, type PlayerSheetView } from "./chapter-sheet";

const chapters: PlayerChapter[] = [
  { id: "one", position: 0, title: "One", startMs: 0, endMs: 30_000 },
];
const history: PlaybackHistoryEntry[] = [
  {
    id: "action-1",
    action: "skip_back",
    positionMs: 10_000,
    previousPositionMs: 25_000,
    playbackRate: 1.25,
    description: "15 seconds",
    occurredAt: "2026-07-12T18:30:00.000Z",
    recordedAt: "2026-07-12T18:30:01.000Z",
  },
];

function SheetHarness({
  onChapterSelect,
  onHistoryRestore,
  onClose,
}: {
  onChapterSelect: (positionMs: number) => void;
  onHistoryRestore: (positionMs: number) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<PlayerSheetView>("chapters");
  return (
    <PlayerSheet
      open
      view={view}
      onViewChange={setView}
      onClose={onClose}
      chapters={chapters}
      history={history}
      activeChapterId="one"
      isPlaying={false}
      onChapterSelect={onChapterSelect}
      onHistoryRestore={onHistoryRestore}
    />
  );
}

describe("player detail tabs", () => {
  it("supports the ARIA tab pattern and restores a history position", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onChapterSelect = vi.fn();
    const onHistoryRestore = vi.fn();
    const onClose = vi.fn();
    render(
      <SheetHarness
        onChapterSelect={onChapterSelect}
        onHistoryRestore={onHistoryRestore}
        onClose={onClose}
      />,
    );

    const chaptersTab = screen.getByRole("tab", { name: "Chapters" });
    const historyTab = screen.getByRole("tab", { name: "History" });
    expect(chaptersTab).toHaveAttribute("aria-selected", "true");
    expect(chaptersTab).toHaveAttribute("aria-controls");
    expect(chaptersTab).toHaveAttribute("tabindex", "0");
    expect(historyTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", chaptersTab.id);

    chaptersTab.focus();
    fireEvent.keyDown(chaptersTab, { key: "ArrowRight" });
    expect(historyTab).toHaveAttribute("aria-selected", "true");
    expect(historyTab).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", historyTab.id);

    fireEvent.click(screen.getByRole("button", { name: /Rewound · 15 seconds/ }));
    expect(onHistoryRestore).toHaveBeenCalledWith(10_000);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
