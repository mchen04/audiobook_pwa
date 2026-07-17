"use client";

import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowLeft,
  CaretLeft,
  CaretRight,
  Clock,
  ClockCounterClockwise,
  DotsThreeCircle,
  ListBullets,
  Pause,
  Play,
} from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import type { BookDetails } from "@/components/book/book-details-dialog";
import type { NextInCollection, PlaybackHistorySnapshot, PlayerBook } from "@/domain/player";
import { formatClock } from "@/lib/format-time";

import { PlayerSheet, type PlayerSheetView } from "./chapter-sheet";
import {
  useCurrentChapter,
  usePlayback,
  usePlaybackDerived,
  usePlaybackTime,
} from "./playback-provider";
import type { SleepMode } from "./use-sleep-timer";

// The details dialog is a heavy edit form most sessions never open; load it
// on first use and keep it out of the player bundle.
const BookDetailsDialog = dynamic(
  () => import("@/components/book/book-details-dialog").then((mod) => mod.BookDetailsDialog),
  { ssr: false },
);

export function FullPlayer({
  playerBook,
  historySnapshot,
  offlineMode = false,
  backHref = "/library",
  backLabel = "Library",
  autoplay = false,
  details = null,
  nextInCollection = null,
}: {
  playerBook: PlayerBook;
  historySnapshot?: PlaybackHistorySnapshot;
  offlineMode?: boolean;
  backHref?: string;
  backLabel?: string;
  autoplay?: boolean;
  details?: BookDetails | null;
  nextInCollection?: NextInCollection | null;
}) {
  const router = useRouter();
  const playback = usePlayback();
  const currentChapter = useCurrentChapter();
  const { loadBook } = playback;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetView, setSheetView] = useState<PlayerSheetView | null>(null);
  const mountedEndedAtRef = useRef(playback.lastEndedAt);
  const autoplayConsumedForRef = useRef<string | null>(null);

  useEffect(() => {
    const shouldAutoplay = autoplay && autoplayConsumedForRef.current !== playerBook.id;
    autoplayConsumedForRef.current = playerBook.id;
    loadBook(playerBook, shouldAutoplay, historySnapshot);
  }, [autoplay, historySnapshot, loadBook, playerBook]);

  const autoplayNext = playback.preferences.autoplayNextInCollection;
  useEffect(() => {
    if (playback.lastEndedAt === mountedEndedAtRef.current) return;
    mountedEndedAtRef.current = playback.lastEndedAt;
    if (!offlineMode && autoplayNext && nextInCollection) {
      router.push(`/books/${nextInCollection.id}?autoplay=1`);
    }
  }, [autoplayNext, nextInCollection, offlineMode, playback.lastEndedAt, router]);

  // Chapter positions are validated to equal their array index.
  const chapterIndex = currentChapter?.position ?? -1;

  function moveChapter(delta: number) {
    const target = playerBook.chapters[chapterIndex + delta];
    if (target) {
      playback.moveToChapter(target, delta < 0 ? "previous" : "next");
    }
  }

  const skipBackSeconds = Math.round(playback.preferences.skipBackMs / 1000);
  const skipForwardSeconds = Math.round(playback.preferences.skipForwardMs / 1000);

  return (
    <div className="player-page">
      <div className="player-topbar" inert={sheetView ? true : undefined}>
        <Link href={backHref} className="icon-text-button">
          <ArrowLeft size={19} aria-hidden="true" />
          <span>{backLabel}</span>
        </Link>
        <span>{currentChapter?.title || "Full audiobook"}</span>
        <div className="player-topbar-actions">
          {details && !offlineMode && (
            <button type="button" className="icon-text-button" onClick={() => setDetailsOpen(true)}>
              <DotsThreeCircle size={19} aria-hidden="true" />
              <span>Details</span>
            </button>
          )}
        </div>
      </div>

      <div className="player-layout">
        <section
          className="player-main"
          aria-labelledby="book-title"
          inert={sheetView ? true : undefined}
        >
          <div className="player-hero">
            {playerBook.coverUrl ? (
              <Image
                className="player-cover"
                src={playerBook.coverUrl}
                alt=""
                width={320}
                height={480}
                unoptimized
                priority
              />
            ) : (
              <div className="player-cover" aria-hidden="true">
                <span>{playerBook.title.slice(0, 2).toUpperCase()}</span>
                <small>MP3</small>
              </div>
            )}

            <div className="player-book-copy">
              <h1 id="book-title">{playerBook.title}</h1>
              <p>{playerBook.author}</p>
            </div>
          </div>

          <Scrubber durationMs={playerBook.durationMs} onSeek={playback.seek} />

          <div className="transport-controls">
            <button
              type="button"
              onClick={() => moveChapter(-1)}
              disabled={chapterIndex <= 0}
              aria-label="Previous chapter"
            >
              <CaretLeft size={22} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => playback.skip(-playback.preferences.skipBackMs)}
              aria-label={`Back ${skipBackSeconds} seconds`}
              className="timed-skip"
            >
              <ArrowCounterClockwise size={34} />
              <small>{skipBackSeconds}</small>
            </button>
            <button
              type="button"
              className="main-play"
              onClick={playback.toggle}
              aria-label={playback.isPlaying ? "Pause" : "Play"}
            >
              {playback.isPlaying ? (
                <Pause size={32} weight="fill" />
              ) : (
                <Play size={32} weight="fill" />
              )}
            </button>
            <button
              type="button"
              onClick={() => playback.skip(playback.preferences.skipForwardMs)}
              aria-label={`Forward ${skipForwardSeconds} seconds`}
              className="timed-skip"
            >
              <ArrowClockwise size={34} />
              <small>{skipForwardSeconds}</small>
            </button>
            <button
              type="button"
              onClick={() => moveChapter(1)}
              disabled={chapterIndex < 0 || chapterIndex >= playerBook.chapters.length - 1}
              aria-label="Next chapter"
            >
              <CaretRight size={22} weight="bold" />
            </button>
          </div>

          <div className="player-options">
            <label>
              <span className="visually-hidden">Playback speed</span>
              <select
                value={playback.playbackRate}
                onChange={(event) => playback.setPlaybackRate(Number(event.target.value))}
              >
                {[0.5, 0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => (
                  <option value={rate} key={rate}>
                    {rate}x
                  </option>
                ))}
              </select>
            </label>
            <SleepMenu />
            <div className="player-sheet-tabs" aria-label="Player details">
              <button
                type="button"
                onClick={() => setSheetView("chapters")}
                aria-label="Chapters"
                aria-haspopup="dialog"
                aria-expanded={sheetView === "chapters"}
              >
                <ListBullets size={19} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setSheetView("history")}
                aria-label="History"
                aria-haspopup="dialog"
                aria-expanded={sheetView === "history"}
              >
                <ClockCounterClockwise size={19} aria-hidden="true" />
              </button>
            </div>
          </div>
          {nextInCollection && !offlineMode && (
            <p className="up-next">
              Up next in {nextInCollection.collectionName}:{" "}
              <Link href={`/books/${nextInCollection.id}`}>{nextInCollection.title}</Link>
              {playback.preferences.autoplayNextInCollection ? " · plays automatically" : ""}
            </p>
          )}
        </section>
      </div>

      <PlayerSheet
        open={sheetView !== null}
        view={sheetView || "chapters"}
        onViewChange={setSheetView}
        onClose={() => setSheetView(null)}
        chapters={playerBook.chapters}
        history={playback.history}
        historyNotice={playback.historyNotice}
        activeChapterId={currentChapter?.id ?? null}
        isPlaying={playback.isPlaying}
        onChapterSelect={playback.seek}
        onHistoryRestore={playback.restoreHistoryPosition}
        diagnostic={details?.chapterDiagnostic}
      />

      {details && detailsOpen && (
        <BookDetailsDialog details={details} open onClose={() => setDetailsOpen(false)} />
      )}
    </div>
  );
}

function Scrubber({
  durationMs,
  onSeek,
}: {
  durationMs: number;
  onSeek: (positionMs: number) => void;
}) {
  const currentTimeMs = usePlaybackTime();
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const shownMs = scrubMs ?? Math.min(currentTimeMs, durationMs);
  const fillPercent = durationMs ? (shownMs / durationMs) * 100 : 0;

  function commit(value: number) {
    draggingRef.current = false;
    setScrubMs(null);
    onSeek(value);
  }

  return (
    <div className={`scrubber ${scrubMs !== null ? "is-scrubbing" : ""}`}>
      <input
        type="range"
        min={0}
        max={durationMs}
        step={Math.max(1_000, Math.round(durationMs / 600 / 1000) * 1000)}
        value={shownMs}
        style={{ "--scrub-fill": `${fillPercent}%` } as React.CSSProperties}
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        onChange={(event) => {
          // While a pointer drag is active, only preview; the seek happens
          // once on release. Keyboard changes seek immediately.
          const value = Number(event.target.value);
          if (draggingRef.current) setScrubMs(value);
          else onSeek(value);
        }}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerCancel={() => {
          draggingRef.current = false;
          setScrubMs(null);
        }}
        aria-label="Audiobook position"
        aria-valuetext={`${formatClock(shownMs)} of ${formatClock(durationMs)}`}
      />
      <div>
        <span>{formatClock(shownMs)}</span>
        <span>-{formatClock(Math.max(0, durationMs - shownMs))}</span>
      </div>
    </div>
  );
}

function SleepMenu() {
  const playback = usePlayback();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Tapping anywhere outside the open menu dismisses it.
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) {
        details.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function choose(action: () => void) {
    action();
    detailsRef.current?.removeAttribute("open");
  }

  function submitCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minutes = Number(new FormData(event.currentTarget).get("minutes"));
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 600) {
      choose(() => playback.setSleepMinutes(Math.round(minutes)));
    }
  }

  return (
    <details
      className="sleep-menu"
      ref={detailsRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsRef.current?.open) {
          detailsRef.current.removeAttribute("open");
          detailsRef.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>
        <Clock size={19} />
        <SleepLabel mode={playback.sleepMode} />
      </summary>
      <div>
        {[15, 30, 45, 60].map((minutes) => (
          <button
            type="button"
            key={minutes}
            onClick={() => choose(() => playback.setSleepMinutes(minutes))}
          >
            {minutes} min
          </button>
        ))}
        <button type="button" onClick={() => choose(playback.setSleepAtChapterEnd)}>
          End of chapter
        </button>
        <form className="sleep-custom" onSubmit={submitCustom}>
          <input
            type="number"
            name="minutes"
            min={1}
            max={600}
            placeholder="Minutes"
            aria-label="Custom sleep timer minutes"
          />
          <button type="submit">Set</button>
        </form>
        {playback.sleepMode && (
          <button type="button" onClick={() => choose(playback.clearSleep)}>
            Turn off
          </button>
        )}
      </div>
    </details>
  );
}

function SleepLabel({ mode }: { mode: SleepMode }) {
  // Recomputed each playback tick, but only a label change re-renders.
  const label = usePlaybackDerived(() => sleepLabel(mode));
  return <span aria-live="polite">{label}</span>;
}

function sleepLabel(mode: SleepMode): string {
  if (!mode) return "Sleep timer";
  if (mode.kind === "chapter") return "End of chapter";
  return `${Math.max(1, Math.ceil((mode.endsAt - Date.now()) / 60_000))} min left`;
}
