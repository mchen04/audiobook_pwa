// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSentence } from "@/domain/transcript";

// A mutable clock the mocked provider reads; tests advance it then re-render.
const clock = vi.hoisted(() => ({ ms: 0 }));

vi.mock("./playback-provider", () => ({
  // Mirrors the real hook: recompute the derivation against the current time.
  usePlaybackTimeDerived: <T,>(derive: (timeMs: number) => T) => derive(clock.ms),
}));

import { CoverNowReading, TranscriptPane } from "./transcript-pane";

function word(text: string, start: number, end: number, cs: number, ce: number) {
  return { text, startMs: start, endMs: end, charStart: cs, charEnd: ce };
}

const wordSentences: TranscriptSentence[] = [
  {
    text: "The tower stood by the bay.",
    startMs: 0,
    endMs: 1200,
    words: [
      word("The", 0, 300, 0, 3),
      word("tower", 300, 700, 4, 9),
      word("bay", 900, 1200, 23, 26),
    ],
  },
  {
    text: "Rain struck the glass.",
    startMs: 2000,
    endMs: 3000,
    words: [word("Rain", 2000, 2400, 0, 4), word("struck", 2400, 2800, 5, 11)],
  },
];

const sentenceOnly: TranscriptSentence[] = [
  { text: "First chunk of narration.", startMs: 0, endMs: 1500, words: [] },
  { text: "A second chunk follows.", startMs: 1500, endMs: 3000, words: [] },
];

beforeEach(() => {
  clock.ms = 0;
  // jsdom lacks these APIs the pane touches for auto-scroll and fade state.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function activeText(): string | null {
  return document.querySelector(".transcript-sentence.is-active")?.textContent ?? null;
}

describe("TranscriptPane", () => {
  it("highlights the sentence and marks the word at the playhead", () => {
    clock.ms = 400; // inside sentence 0, on "tower"
    render(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(activeText()).toContain("The tower stood by the bay.");
    expect(screen.getByText("tower").tagName).toBe("MARK");
  });

  it("advances sentence and word marking as the clock moves (binary search)", () => {
    const { rerender } = render(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    clock.ms = 950; // still sentence 0, now on "bay"
    rerender(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("bay").tagName).toBe("MARK");

    clock.ms = 2500; // sentence 1, on "struck"
    rerender(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(activeText()).toContain("Rain struck the glass.");
    expect(screen.getByText("struck").tagName).toBe("MARK");
  });

  it("respects the chapter start offset when the chapter does not start at zero", () => {
    clock.ms = 30_400; // chapter starts at 30s -> 400ms in -> "tower"
    render(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={30_000}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("tower").tagName).toBe("MARK");
  });

  it("shows no active highlight before the first cue (edge position)", () => {
    clock.ms = 0;
    render(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={5_000}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(activeText()).toBeNull();
  });

  it("degrades to sentence-only highlighting when there are no word cues", () => {
    clock.ms = 1800; // sentence 1 of the sentence-only transcript
    render(
      <TranscriptPane
        sentences={sentenceOnly}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    expect(activeText()).toContain("A second chunk follows.");
    expect(document.querySelector(".transcript-word")).toBeNull();
  });

  it("seeks to the tapped sentence's chapter-absolute start", () => {
    const onSeek = vi.fn();
    render(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={30_000}
        chapterTitle="Ch"
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Rain struck the glass\./ }));
    expect(onSeek).toHaveBeenCalledWith(32_000); // 30_000 + 2_000
  });

  it("renders a quiet pane while cues are still pending", () => {
    render(
      <TranscriptPane
        sentences={[]}
        chapterStartMs={0}
        chapterTitle="Ch"
        pending
        onSeek={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No text/)).toBeNull();
  });

  it("shows an empty-state message once a chapter is known to have no cues", () => {
    render(
      <TranscriptPane sentences={[]} chapterStartMs={0} chapterTitle="Ch Nine" onSeek={vi.fn()} />,
    );
    expect(screen.getByText(/No text for Ch Nine/)).toBeInTheDocument();
  });

  it("attaches manual-scroll grace after mounting empty then filling (chapter swap)", () => {
    // The container only exists after cues load; the pane also mounts empty on
    // every chapter change. A manual scroll must still pause auto-scroll.
    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    clock.ms = 400;
    const { rerender, container } = render(
      <TranscriptPane
        sentences={[]}
        chapterStartMs={0}
        chapterTitle="Ch"
        pending
        onSeek={vi.fn()}
      />,
    );
    rerender(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    scrollIntoView.mockClear();

    // Reader scrolls by hand -> grace window opens.
    fireEvent.wheel(container.querySelector(".transcript-pane")!);
    // Narration advances to the next sentence.
    clock.ms = 2500;
    rerender(
      <TranscriptPane
        sentences={wordSentences}
        chapterStartMs={0}
        chapterTitle="Ch"
        onSeek={vi.fn()}
      />,
    );
    // Auto-scroll must stay paused: no scrollIntoView during the grace window.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("CoverNowReading", () => {
  it("echoes the narrated sentence and disappears before the first cue", () => {
    clock.ms = 500;
    const { rerender, container } = render(
      <CoverNowReading sentences={wordSentences} chapterStartMs={0} />,
    );
    expect(container.querySelector(".player-now-reading")?.textContent).toBe(
      "The tower stood by the bay.",
    );

    clock.ms = 0;
    rerender(<CoverNowReading sentences={wordSentences} chapterStartMs={5_000} />);
    expect(container.querySelector(".player-now-reading")).toBeNull();
  });
});
