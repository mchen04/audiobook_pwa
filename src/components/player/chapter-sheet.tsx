"use client";

import { ClockCounterClockwise, ListBullets, X } from "@phosphor-icons/react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type { PlaybackHistoryEntry, PlayerChapter } from "@/domain/player";
import { formatClock, formatDurationRounded } from "@/lib/format-time";

import { CHAPTER_WINDOW_SIZE, chapterWindow, chapterWindowStart } from "./chapter-window";
import { HistoryList } from "./history-list";

const DISMISS_DRAG_PX = 90;

/**
 * Bottom sheet over the lower half of the screen. Dismisses by tapping the
 * scrim above it, dragging it down (when its list is scrolled to the top),
 * or pressing Escape. The list itself scrolls natively inside.
 */
export type PlayerSheetView = "chapters" | "history";

export function PlayerSheet({
  open,
  view,
  onViewChange,
  onClose,
  chapters,
  history,
  historyNotice,
  activeChapterId,
  isPlaying,
  onChapterSelect,
  onHistoryRestore,
  diagnostic,
}: {
  open: boolean;
  view: PlayerSheetView;
  onViewChange: (view: PlayerSheetView) => void;
  onClose: () => void;
  chapters: PlayerChapter[];
  history: PlaybackHistoryEntry[];
  historyNotice?: string | null;
  activeChapterId: string | null;
  isPlaying: boolean;
  onChapterSelect: (positionMs: number) => void;
  onHistoryRestore: (positionMs: number) => void;
  diagnostic?: string | null;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [manualStart, setManualStart] = useState<number | null>(null);
  const sheetId = useId();
  const chapterTabId = `${sheetId}-chapters-tab`;
  const historyTabId = `${sheetId}-history-tab`;
  const panelId = `${sheetId}-panel`;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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

  // Center the active chapter and move focus in when the sheet opens;
  // restore focus to the opener when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    scrollRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
    sheetRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  // Drag-down to dismiss. Native listeners: React's synthetic touch events
  // are passive, and the drag must preventDefault to stop list scrolling.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!open || !sheet) return;
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
      sheet!.style.transform = `translateY(${Math.max(0, delta)}px)`;
      sheet!.style.transition = "none";
    }

    function onTouchEnd() {
      if (!dragging) return;
      sheet!.style.transition = "";
      sheet!.style.transform = "";
      if (delta > DISMISS_DRAG_PX) onCloseRef.current();
    }

    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    sheet.addEventListener("touchend", onTouchEnd);
    sheet.addEventListener("touchcancel", onTouchEnd);
    return () => {
      sheet.removeEventListener("touchstart", onTouchStart);
      sheet.removeEventListener("touchmove", onTouchMove);
      sheet.removeEventListener("touchend", onTouchEnd);
      sheet.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [open]);

  if (!open) return null;

  function handleTabKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const views: PlayerSheetView[] = ["chapters", "history"];
    const current = views.indexOf(view);
    const target =
      event.key === "Home"
        ? views[0]
        : event.key === "End"
          ? views[1]
          : event.key === "ArrowLeft"
            ? views[(current - 1 + views.length) % views.length]
            : event.key === "ArrowRight"
              ? views[(current + 1) % views.length]
              : null;
    if (!target) return;
    event.preventDefault();
    onViewChange(target);
    sheetRef.current?.querySelector<HTMLElement>(`[data-sheet-tab="${target}"]`)?.focus();
  }

  return (
    <div
      className="sheet-root"
      role="dialog"
      aria-modal="true"
      aria-label={view === "chapters" ? "Chapters" : "Playback history"}
    >
      <button
        type="button"
        className="sheet-backdrop"
        onClick={onClose}
        aria-label="Close player details"
      />
      <div className="sheet-panel" ref={sheetRef} tabIndex={-1}>
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <div
            className="sheet-tabs"
            role="tablist"
            aria-label="Player details"
            onKeyDown={handleTabKey}
          >
            <button
              type="button"
              role="tab"
              id={chapterTabId}
              data-sheet-tab="chapters"
              aria-controls={panelId}
              aria-selected={view === "chapters"}
              aria-label="Chapters"
              tabIndex={view === "chapters" ? 0 : -1}
              onClick={() => onViewChange("chapters")}
            >
              <ListBullets size={19} aria-hidden="true" />
            </button>
            <button
              type="button"
              role="tab"
              id={historyTabId}
              data-sheet-tab="history"
              aria-controls={panelId}
              aria-selected={view === "history"}
              aria-label="History"
              tabIndex={view === "history" ? 0 : -1}
              onClick={() => onViewChange("history")}
            >
              <ClockCounterClockwise size={19} aria-hidden="true" />
            </button>
          </div>
          <h2>{view === "chapters" ? "Chapters" : "History"}</h2>
          <span>{view === "chapters" ? chapters.length : history.length}</span>
          <button type="button" onClick={onClose} aria-label="Close player details">
            <X size={18} />
          </button>
        </div>
        <div
          className="sheet-scroll"
          ref={scrollRef}
          id={panelId}
          role="tabpanel"
          aria-labelledby={view === "chapters" ? chapterTabId : historyTabId}
          tabIndex={0}
        >
          {view === "chapters" && diagnostic && <p className="chapter-diagnostic">{diagnostic}</p>}
          {view === "history" && historyNotice && (
            <p className="history-notice" role="status">
              {historyNotice}
            </p>
          )}
          {view === "chapters" && windowStart > 0 && (
            <button
              type="button"
              className="secondary-button chapter-window-button"
              onClick={() => setManualStart(Math.max(0, windowStart - CHAPTER_WINDOW_SIZE))}
            >
              Earlier chapters
            </button>
          )}
          {view === "chapters" ? (
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
                        onChapterSelect(chapter.startMs);
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
          ) : (
            <HistoryList
              history={history}
              chapters={chapters}
              onSelect={(positionMs) => {
                onHistoryRestore(positionMs);
                onClose();
              }}
            />
          )}
          {view === "chapters" && windowStart + visibleChapters.length < chapters.length && (
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
        </div>
      </div>
    </div>
  );
}
