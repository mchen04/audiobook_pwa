"use client";

import { X } from "@phosphor-icons/react";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { PlayerChapter } from "@/domain/player";
import { formatClock, formatDurationRounded } from "@/lib/format-time";

import { CHAPTER_WINDOW_SIZE, chapterWindow, chapterWindowStart } from "./chapter-window";

const DISMISS_DRAG_PX = 90;

/**
 * Bottom sheet over the lower half of the screen. Dismisses by tapping the
 * scrim above it, dragging it down (when its list is scrolled to the top),
 * or pressing Escape. The list itself scrolls natively inside.
 */
export function ChapterSheet({
  open,
  onClose,
  chapters,
  activeChapterId,
  isPlaying,
  onSeek,
  diagnostic,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  chapters: PlayerChapter[];
  activeChapterId: string | null;
  isPlaying: boolean;
  onSeek: (positionMs: number) => void;
  diagnostic?: string | null;
  footer?: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [manualStart, setManualStart] = useState<number | null>(null);

  const activeIndex = chapters.findIndex((chapter) => chapter.id === activeChapterId);
  const windowStart = manualStart ?? chapterWindowStart(Math.max(0, activeIndex), chapters.length);
  const visibleChapters = chapterWindow(chapters, windowStart);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Center the active chapter when the sheet opens.
  useEffect(() => {
    if (!open) return;
    scrollRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }, [open]);

  // Drag-down to dismiss. Native listeners: React's synthetic touch events
  // are passive, and the drag must preventDefault to stop list scrolling.
  const attachDrag = useCallback(
    (node: HTMLDivElement | null) => {
      sheetRef.current = node;
      if (!node) return;
      const sheet = node;
      let startY = 0;
      let delta = 0;
      let dragging = false;

      function onTouchStart(event: TouchEvent) {
        startY = event.touches[0]!.clientY;
        delta = 0;
        dragging = false;
      }

      function onTouchMove(event: TouchEvent) {
        const y = event.touches[0]!.clientY;
        const scroller = scrollRef.current;
        const atTop = !scroller || scroller.scrollTop <= 0;
        const withinScroller = scroller?.contains(event.target as Node) ?? false;
        delta = y - startY;
        if (!dragging && delta > 6 && (atTop || !withinScroller)) dragging = true;
        if (!dragging) return;
        event.preventDefault();
        sheet.style.transform = `translateY(${Math.max(0, delta)}px)`;
        sheet.style.transition = "none";
      }

      function onTouchEnd() {
        if (!dragging) return;
        sheet.style.transition = "";
        if (delta > DISMISS_DRAG_PX) {
          onClose();
          sheet.style.transform = "";
        } else {
          sheet.style.transform = "";
        }
      }

      sheet.addEventListener("touchstart", onTouchStart, { passive: true });
      sheet.addEventListener("touchmove", onTouchMove, { passive: false });
      sheet.addEventListener("touchend", onTouchEnd);
      sheet.addEventListener("touchcancel", onTouchEnd);
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label="Chapters">
      <button
        type="button"
        className="sheet-backdrop"
        onClick={onClose}
        aria-label="Close chapters"
      />
      <div className="sheet-panel" ref={attachDrag}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <h2>Chapters</h2>
          <span>{chapters.length}</span>
          <button type="button" onClick={onClose} aria-label="Close chapters">
            <X size={18} />
          </button>
        </div>
        <div className="sheet-scroll" ref={scrollRef}>
          {diagnostic && <p className="chapter-diagnostic">{diagnostic}</p>}
          {windowStart > 0 && (
            <button
              type="button"
              className="secondary-button chapter-window-button"
              onClick={() => setManualStart(Math.max(0, windowStart - CHAPTER_WINDOW_SIZE))}
            >
              Earlier chapters
            </button>
          )}
          <ol className="sheet-chapters">
            {visibleChapters.map((chapter) => {
              const active = chapter.id === activeChapterId;
              const lengthMs = chapter.endMs - chapter.startMs;
              return (
                <li key={chapter.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      setManualStart(null);
                      onSeek(chapter.startMs);
                      onClose();
                    }}
                  >
                    <span>{chapter.position + 1}</span>
                    <span>
                      <strong>{chapter.title}</strong>
                      <small>
                        {formatDurationRounded(lengthMs)} · {formatClock(chapter.startMs)} –{" "}
                        {formatClock(chapter.endMs)}
                      </small>
                    </span>
                    {active && isPlaying && (
                      <span className="playing-bars" aria-label="Playing">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
          {windowStart + visibleChapters.length < chapters.length && (
            <button
              type="button"
              className="secondary-button chapter-window-button"
              onClick={() =>
                setManualStart(
                  Math.min(
                    chapters.length - CHAPTER_WINDOW_SIZE,
                    windowStart + CHAPTER_WINDOW_SIZE,
                  ),
                )
              }
            >
              Later chapters
            </button>
          )}
          {footer}
        </div>
      </div>
    </div>
  );
}
