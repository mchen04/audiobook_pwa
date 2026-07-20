"use client";

import { memo, useCallback, useEffect, useRef } from "react";

import type { TranscriptSentence } from "@/domain/transcript";
import { activeCueIndex } from "@/domain/transcript-cues";

import { usePlaybackTimeDerived } from "./playback-provider";

/** How long after the reader stops scrolling before auto-follow resumes. */
const MANUAL_SCROLL_GRACE_MS = 3500;

/**
 * The read-along pane that replaces the cover: the sentence being narrated is
 * highlighted and kept in view, and the word being spoken is marked inside
 * it. Rendering is tiered so the ticking clock never touches the whole list:
 * word ticks re-render only the active sentence, sentence changes re-render
 * exactly two memoized rows.
 */
export function TranscriptPane({
  sentences,
  chapterStartMs,
  chapterTitle,
  pending = false,
  onSeek,
}: {
  sentences: TranscriptSentence[];
  chapterStartMs: number;
  chapterTitle: string;
  /** Cues are still loading; render quietly instead of "no text". */
  pending?: boolean;
  onSeek: (positionMs: number) => void;
}) {
  const activeIndex = usePlaybackTimeDerived((timeMs) =>
    activeCueIndex(sentences, timeMs - chapterStartMs),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const manualUntilRef = useRef(0);

  // The bottom fade is a scroll affordance; showing it on a fully visible
  // list would read as accidental truncation instead.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () =>
      container.classList.toggle("is-scrollable", container.scrollHeight > container.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sentences]);

  useEffect(() => {
    // The scroll container only exists once cues render (the empty/pending
    // state is a different element), and the pane remounts per chapter, so
    // this must re-run when sentences arrive — not just at mount — or the
    // manual-scroll grace never attaches after a chapter change.
    const container = scrollRef.current;
    if (!container) return;
    const noteManualScroll = () => {
      manualUntilRef.current = Date.now() + MANUAL_SCROLL_GRACE_MS;
    };
    container.addEventListener("wheel", noteManualScroll, { passive: true });
    container.addEventListener("touchmove", noteManualScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", noteManualScroll);
      container.removeEventListener("touchmove", noteManualScroll);
    };
  }, [sentences]);

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < manualUntilRef.current) return;
    activeRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  const seekToSentence = useCallback(
    (sentence: TranscriptSentence) => {
      // A tapped sentence is a navigation intent: follow it immediately.
      manualUntilRef.current = 0;
      onSeek(chapterStartMs + sentence.startMs);
    },
    [chapterStartMs, onSeek],
  );

  if (sentences.length === 0) {
    return (
      <div className="transcript-pane transcript-pane-empty">
        {!pending && <p>No text for {chapterTitle || "this chapter"}.</p>}
      </div>
    );
  }

  return (
    <div className="transcript-pane" ref={scrollRef} aria-label="Read-along text">
      <ol className="transcript-sentences">
        {sentences.map((sentence, index) => (
          <SentenceRow
            key={index}
            sentence={sentence}
            chapterStartMs={chapterStartMs}
            isActive={index === activeIndex}
            rowRef={index === activeIndex ? activeRowRef : undefined}
            onSelect={seekToSentence}
          />
        ))}
      </ol>
    </div>
  );
}

/** A single dimmed line under the cover echoing the sentence being narrated. */
export function CoverNowReading({
  sentences,
  chapterStartMs,
}: {
  sentences: TranscriptSentence[];
  chapterStartMs: number;
}) {
  const text = usePlaybackTimeDerived((timeMs) => {
    const index = activeCueIndex(sentences, timeMs - chapterStartMs);
    return index >= 0 ? sentences[index]!.text : "";
  });
  // Marked aria-hidden: the text view is the accessible read-along surface;
  // this cover echo would otherwise announce a new sentence every few seconds.
  return text ? (
    <p className="player-now-reading" aria-hidden="true">
      {text}
    </p>
  ) : null;
}

const SentenceRow = memo(function SentenceRow({
  sentence,
  chapterStartMs,
  isActive,
  rowRef,
  onSelect,
}: {
  sentence: TranscriptSentence;
  chapterStartMs: number;
  isActive: boolean;
  rowRef?: React.RefObject<HTMLButtonElement | null>;
  onSelect: (sentence: TranscriptSentence) => void;
}) {
  return (
    <li>
      <button
        type="button"
        ref={rowRef}
        className={`transcript-sentence ${isActive ? "is-active" : ""}`}
        aria-current={isActive || undefined}
        onClick={() => onSelect(sentence)}
      >
        <span className="transcript-sentence-text">
          {isActive && sentence.words.length > 0 ? (
            <ActiveSentence sentence={sentence} chapterStartMs={chapterStartMs} />
          ) : (
            sentence.text
          )}
        </span>
      </button>
    </li>
  );
});

/** Word-level karaoke marking; the only node that re-renders per word cue. */
function ActiveSentence({
  sentence,
  chapterStartMs,
}: {
  sentence: TranscriptSentence;
  chapterStartMs: number;
}) {
  // An unanchored cue (empty char range) keeps the previous word marked
  // rather than dropping the marker mid-sentence.
  const markedIndex = usePlaybackTimeDerived((timeMs) => {
    let index = activeCueIndex(sentence.words, timeMs - chapterStartMs);
    while (index >= 0 && sentence.words[index]!.charStart >= sentence.words[index]!.charEnd) {
      index -= 1;
    }
    return index;
  });
  const word = markedIndex >= 0 ? sentence.words[markedIndex] : undefined;
  if (!word) return <>{sentence.text}</>;
  return (
    <>
      {sentence.text.slice(0, word.charStart)}
      <mark className="transcript-word">{sentence.text.slice(word.charStart, word.charEnd)}</mark>
      {sentence.text.slice(word.charEnd)}
    </>
  );
}
