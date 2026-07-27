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
  TextAlignLeft,
  X,
} from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import type { BookDetails } from "@/components/book/book-details-dialog";
import type { NextInCollection, PlaybackHistorySnapshot, PlayerBook } from "@/domain/player";
import type { TranscriptSentence } from "@/domain/transcript";
import { formatClock, formatDurationRounded } from "@/lib/format-time";
import { getChapterTranscript, getTranscriptChapterIndexes } from "@/lib/offline/transcript-store";
import type { SuspendedSession } from "@/lib/playback-core";

import { PlayerSheet, type PlayerSheetView } from "./chapter-sheet";
import {
  useCurrentChapter,
  usePlayback,
  usePlaybackDerived,
  usePlaybackTime,
} from "./playback-provider";
import { CoverNowReading, TranscriptPane } from "./transcript-pane";
import type { SleepMode } from "./use-sleep-timer";
import { useSuspensionRecovery } from "./use-suspension-recovery";

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
  onBack,
  autoplay = false,
  details = null,
  nextInCollection = null,
}: {
  playerBook: PlayerBook;
  historySnapshot?: PlaybackHistorySnapshot;
  offlineMode?: boolean;
  backHref?: string;
  backLabel?: string;
  /**
   * Returns to the caller's own view instead of navigating. The library uses
   * it for the player it opens in place, where a navigation is exactly what
   * the device could not do.
   */
  onBack?: () => void;
  autoplay?: boolean;
  details?: BookDetails | null;
  nextInCollection?: NextInCollection | null;
}) {
  const router = useRouter();
  const playback = usePlayback();
  const currentChapter = useCurrentChapter();
  const { loadBook } = playback;
  /**
   * DECLARED BEFORE EVERY OTHER EFFECT IN THIS COMPONENT, and specifically
   * before the one that calls `loadBook`.
   *
   * Effects run in declaration order, and what this hook reads is the durable
   * record as the LAUNCH found it. The signature it looks for is "nothing wrote
   * after the hide edge", so the first durable write of the new session — which
   * an `?autoplay=1` open makes within 200 ms of `loadBook` — destroys it.
   * Reading first is what keeps the offer available on the one path where the
   * user is least able to notice they lost their place.
   */
  const recovery = useSuspensionRecovery({
    userId: playback.userId,
    bookId: playerBook.id,
    durationMs: playerBook.durationMs,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sheetView, setSheetView] = useState<PlayerSheetView | null>(null);
  const mountedEndedAtRef = useRef(playback.lastEndedAt);
  const autoplayConsumedForRef = useRef<string | null>(null);
  // All read-along state is keyed by book (and chapter) instead of being
  // reset in effects: a stale entry for another book simply never matches.
  const [transcriptBookId, setTranscriptBookId] = useState<string | null>(null);
  const [textViewBookId, setTextViewBookId] = useState<string | null>(null);
  const [chapterCues, setChapterCues] = useState<{
    bookId: string;
    chapterIndex: number;
    sentences: TranscriptSentence[];
  } | null>(null);
  const hasTranscript = transcriptBookId === playerBook.id;
  const showText = hasTranscript && textViewBookId === playerBook.id;

  // Read-along cues live only in this device's storage; one indexed lookup
  // decides whether the Text control exists at all.
  useEffect(() => {
    let active = true;
    void getTranscriptChapterIndexes(playback.userId, playerBook.id)
      .then((indexes) => {
        if (active && indexes.length > 0) setTranscriptBookId(playerBook.id);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [playback.userId, playerBook.id]);

  const chapterIndexForCues = currentChapter?.position ?? -1;
  // Cues load for any transcript-bearing book, not just while the text view is
  // open, so the cover can echo the narrated line and the pane opens instantly.
  useEffect(() => {
    if (!hasTranscript || chapterIndexForCues < 0) return;
    let active = true;
    const bookId = playerBook.id;
    void getChapterTranscript(playback.userId, bookId, chapterIndexForCues)
      .then((record) => {
        if (active) {
          setChapterCues({
            bookId,
            chapterIndex: chapterIndexForCues,
            sentences: record?.sentences ?? [],
          });
        }
      })
      .catch(() => {
        if (active) setChapterCues({ bookId, chapterIndex: chapterIndexForCues, sentences: [] });
      });
    return () => {
      active = false;
    };
  }, [hasTranscript, chapterIndexForCues, playback.userId, playerBook.id]);

  const cuesReady =
    chapterCues?.bookId === playerBook.id && chapterCues.chapterIndex === chapterIndexForCues;

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
  // Bound to a const so the jump handler closes over a value TypeScript has
  // narrowed, rather than re-reading a property it cannot narrow inside a
  // callback and needing a non-null assertion to say so.
  const suspensionGap = recovery.gap;

  return (
    <div className="player-page">
      <div className="player-topbar" inert={sheetView ? true : undefined}>
        {onBack ? (
          <button type="button" className="icon-text-button" onClick={onBack}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{backLabel}</span>
          </button>
        ) : (
          <Link href={backHref} className="icon-text-button">
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{backLabel}</span>
          </Link>
        )}
        <span>{currentChapter?.title || "Full audiobook"}</span>
        <div className="player-topbar-actions">
          {hasTranscript && (
            <button
              type="button"
              className={`icon-text-button ${showText ? "is-active" : ""}`}
              aria-pressed={showText}
              onClick={() => setTextViewBookId(showText ? null : playerBook.id)}
            >
              <TextAlignLeft size={19} aria-hidden="true" />
              <span>Text</span>
            </button>
          )}
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
          <div className={`player-hero ${showText ? "has-text" : ""}`}>
            {showText ? (
              <div className="transcript-stage">
                <TranscriptPane
                  key={`${playerBook.id}:${chapterIndexForCues}`}
                  sentences={cuesReady ? chapterCues.sentences : []}
                  chapterStartMs={currentChapter?.startMs ?? 0}
                  chapterTitle={currentChapter?.title ?? ""}
                  pending={!cuesReady}
                  onSeek={playback.seek}
                />
                <button
                  type="button"
                  className="transcript-close"
                  aria-label="Show cover"
                  onClick={() => setTextViewBookId(null)}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <CoverArt
                playerBook={playerBook}
                onFlip={hasTranscript ? () => setTextViewBookId(playerBook.id) : undefined}
              />
            )}

            <div className="player-book-copy">
              <h1 id="book-title">{playerBook.title}</h1>
              <p>{playerBook.author}</p>
              {!showText && hasTranscript && cuesReady && (
                <CoverNowReading
                  sentences={chapterCues.sentences}
                  chapterStartMs={currentChapter?.startMs ?? 0}
                />
              )}
            </div>
          </div>

          {suspensionGap && (
            <SuspensionRecovery
              gap={suspensionGap}
              onJump={() => {
                // The user pressing this IS the authorisation. Nothing on any
                // other path in this app may move the position forward. The
                // seek goes through the ordinary transport, so it is clamped to
                // the book, made durable as a `seek`, and recorded in history —
                // which is also how the user takes it back.
                playback.seek(suspensionGap.projectedPositionMs);
                recovery.dismiss();
              }}
              onDismiss={recovery.dismiss}
            />
          )}

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

      {/*
        Mounted as soon as this book has details, not on the first click.

        The dialog stays a separate chunk — the library bundle, which is what
        launch is measured on, renders `FullPlayer` with no `details` and so
        never fetches it. But on a book page the chunk has to arrive BEFORE the
        connection does not: fetching it on the click threw `ChunkLoadError`
        offline and nothing opened, which would have made the whole offline
        edit surface unreachable exactly when the outbox matters most. The
        element renders nothing until `showModal()` runs.
      */}
      {details && (
        <BookDetailsDialog
          details={details}
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The recovery offer: quiet, dismissible, and never a decision the app makes.
 *
 * WHAT IT IS FOR. `useSuspensionRecovery` has found the signature of a listen
 * this device could not record — the app was backgrounded with the book
 * playing, and nothing wrote after that. The saved place is still the source of
 * truth and is where the player has already resumed; this offers a one-tap jump
 * to where the audio would have got to, and says in as many words that it is an
 * estimate.
 *
 * THE RULES IT KEEPS, all of which are the point rather than decoration:
 *
 *   - `role="status"`, not a dialog. It announces politely and traps nothing;
 *     the transport underneath it stays live and the user can simply play.
 *   - the dismiss control is a peer of the jump, not a corner afterthought, so
 *     "no" is exactly as easy as "yes";
 *   - the saved place is printed next to the estimate, because the number the
 *     user is being asked to leave matters as much as the one on offer;
 *   - "about" leads both figures. Neither is a measurement.
 *
 * The data attributes carry the unrounded numbers for `tests/resume`, which
 * grades the projection against the elapsed time and rate rather than against a
 * clock string quantised to the second.
 */
function SuspensionRecovery({
  gap,
  onJump,
  onDismiss,
}: {
  gap: SuspendedSession;
  onJump: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="resume-recovery"
      role="status"
      data-resume-recovery=""
      data-recorded-ms={Math.round(gap.recordedPositionMs)}
      data-projected-ms={Math.round(gap.projectedPositionMs)}
      data-elapsed-ms={Math.round(gap.elapsedMs)}
      data-playback-rate={gap.playbackRate}
    >
      <p>
        This was playing when the app closed, and about{" "}
        <strong>{formatDurationRounded(gap.elapsedMs)}</strong> went unrecorded.
      </p>
      <div className="resume-recovery-actions">
        <button type="button" className="resume-recovery-jump" onClick={onJump}>
          Jump to about {formatClock(gap.projectedPositionMs)}
        </button>
        <button
          type="button"
          className="resume-recovery-dismiss"
          aria-label="Dismiss the estimate and keep the saved place"
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <small>
        An estimate from the time away and {gap.playbackRate}× speed. Your saved place is{" "}
        {formatClock(gap.recordedPositionMs)}.
      </small>
    </div>
  );
}

function CoverArt({ playerBook, onFlip }: { playerBook: PlayerBook; onFlip?: () => void }) {
  const art = playerBook.coverUrl ? (
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
      <span>{titleMonogram(playerBook.title)}</span>
      <small>MP3</small>
    </div>
  );
  if (!onFlip) return art;
  // The labeled toggle lives in the topbar; the cover itself is a bonus tap
  // target for readers who expect it to flip.
  return (
    <button type="button" className="player-cover-flip" aria-label="Show text" onClick={onFlip}>
      {art}
    </button>
  );
}

/** Word-initial monogram, matching the library's cover placeholders. */
function titleMonogram(title: string): string {
  return (
    title
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AB"
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
