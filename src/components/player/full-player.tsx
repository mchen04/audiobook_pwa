"use client";

import {
  ArrowLeft,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Clock,
  DotsThreeCircle,
  ListBullets,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { BookDetailsDialog, type BookDetails } from "@/components/book/book-details-dialog";
import type { Bookmark, NextInCollection, PlayerBook } from "@/domain/player";
import { formatClock } from "@/lib/format-time";

import { usePlayback } from "./playback-provider";
import { isPendingBookmark, useBookmarks } from "./use-bookmarks";

export function FullPlayer({
  playerBook,
  initialBookmarks,
  offlineMode = false,
  backHref = "/library",
  backLabel = "Library",
  autoplay = false,
  details = null,
  nextInCollection = null,
}: {
  playerBook: PlayerBook;
  initialBookmarks: Bookmark[];
  offlineMode?: boolean;
  backHref?: string;
  backLabel?: string;
  autoplay?: boolean;
  details?: BookDetails | null;
  nextInCollection?: NextInCollection | null;
}) {
  const router = useRouter();
  const playback = usePlayback();
  const { loadBook, userId } = playback;
  const { bookmarks, notice, addBookmark, deleteBookmark, saveBookmarkNote } = useBookmarks(
    userId,
    playerBook.id,
    initialBookmarks,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mountedEndedAtRef = useRef(playback.lastEndedAt);

  useEffect(() => {
    loadBook(playerBook, autoplay);
  }, [autoplay, loadBook, playerBook]);

  const autoplayNext = playback.preferences.autoplayNextInCollection;
  useEffect(() => {
    if (playback.lastEndedAt === mountedEndedAtRef.current) return;
    mountedEndedAtRef.current = playback.lastEndedAt;
    if (!offlineMode && autoplayNext && nextInCollection) {
      router.push(`/books/${nextInCollection.id}?autoplay=1`);
    }
  }, [autoplayNext, nextInCollection, offlineMode, playback.lastEndedAt, router]);

  const chapterIndex = useMemo(
    () => playerBook.chapters.findIndex((chapter) => chapter.id === playback.currentChapter?.id),
    [playback.currentChapter?.id, playerBook.chapters],
  );

  function moveChapter(delta: number) {
    const target = playerBook.chapters[chapterIndex + delta];
    if (target) playback.seek(target.startMs);
  }

  const skipBackSeconds = Math.round(playback.preferences.skipBackMs / 1000);
  const skipForwardSeconds = Math.round(playback.preferences.skipForwardMs / 1000);

  return (
    <div className="player-page">
      <div className="player-topbar">
        <Link href={backHref} className="icon-text-button">
          <ArrowLeft size={19} aria-hidden="true" />
          <span>{backLabel}</span>
        </Link>
        <span>{playback.currentChapter?.title || "Full audiobook"}</span>
        <div className="player-topbar-actions">
          <button
            type="button"
            className="icon-text-button"
            onClick={() => addBookmark(playback.currentTimeMs)}
          >
            <BookmarkSimple size={19} />
            <span>Bookmark</span>
          </button>
          {details && !offlineMode && (
            <button type="button" className="icon-text-button" onClick={() => setDetailsOpen(true)}>
              <DotsThreeCircle size={19} aria-hidden="true" />
              <span>Details</span>
            </button>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite" className="player-notice">
        {notice}
      </div>

      <div className="player-layout">
        <section className="player-main" aria-labelledby="book-title">
          <div className="player-hero">
            {playerBook.coverUrl ? (
              <img className="player-cover" src={playerBook.coverUrl} alt="" />
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

          <div className="scrubber">
            <input
              type="range"
              min={0}
              max={playerBook.durationMs}
              step={Math.max(1_000, Math.round(playerBook.durationMs / 600 / 1000) * 1000)}
              value={Math.min(playback.currentTimeMs, playerBook.durationMs)}
              onChange={(event) => playback.seek(Number(event.target.value))}
              aria-label="Audiobook position"
              aria-valuetext={`${formatClock(playback.currentTimeMs)} of ${formatClock(playerBook.durationMs)}`}
            />
            <div>
              <span>{formatClock(playback.currentTimeMs)}</span>
              <span>
                -{formatClock(Math.max(0, playerBook.durationMs - playback.currentTimeMs))}
              </span>
            </div>
          </div>

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
              <SkipBack size={28} weight="fill" />
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
              <SkipForward size={28} weight="fill" />
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
              <span>Speed</span>
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
          </div>
          {nextInCollection && !offlineMode && (
            <p className="up-next">
              Up next in {nextInCollection.collectionName}:{" "}
              <Link href={`/books/${nextInCollection.id}`}>{nextInCollection.title}</Link>
              {playback.preferences.autoplayNextInCollection ? " · plays automatically" : ""}
            </p>
          )}
        </section>

        <aside className="chapter-panel" aria-labelledby="chapters-title">
          <div className="chapter-panel-heading">
            <div>
              <ListBullets size={20} aria-hidden="true" />
              <h2 id="chapters-title">Chapters</h2>
            </div>
            <span>{playerBook.chapters.length}</span>
          </div>
          {details?.chapterDiagnostic && (
            <p className="chapter-diagnostic">{details.chapterDiagnostic}</p>
          )}
          <ol>
            {playerBook.chapters.map((chapter) => {
              const active = chapter.id === playback.currentChapter?.id;
              return (
                <li key={chapter.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => playback.seek(chapter.startMs)}
                  >
                    <span>{chapter.position + 1}</span>
                    <span>
                      <strong>{chapter.title}</strong>
                      <small>{formatClock(chapter.endMs - chapter.startMs)}</small>
                    </span>
                    {active && playback.isPlaying && (
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

          {bookmarks.length > 0 && (
            <div className="bookmark-list">
              <h2>Bookmarks</h2>
              <ul>
                {bookmarks.map((bookmark) => (
                  <BookmarkRow
                    key={bookmark.id}
                    bookmark={bookmark}
                    onSeek={() => playback.seek(bookmark.positionMs)}
                    onDelete={() => deleteBookmark(bookmark)}
                    onSaveNote={(note) => saveBookmarkNote(bookmark, note)}
                  />
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

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

function BookmarkRow({
  bookmark,
  onSeek,
  onDelete,
  onSaveNote,
}: {
  bookmark: Bookmark;
  onSeek: () => void;
  onDelete: () => void;
  onSaveNote: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget).get("note") || "").trim();
    onSaveNote(note || null);
    setEditing(false);
  }

  return (
    <li>
      <div className="bookmark-row">
        <button type="button" onClick={onSeek}>
          {formatClock(bookmark.positionMs)}
          {bookmark.note && <small>{bookmark.note}</small>}
          {isPendingBookmark(bookmark) && <small>Waiting to sync</small>}
        </button>
        <button
          type="button"
          onClick={() => setEditing((current) => !current)}
          aria-label={`${bookmark.note ? "Edit" : "Add"} note for bookmark at ${formatClock(bookmark.positionMs)}`}
          aria-expanded={editing}
        >
          <span aria-hidden="true">{bookmark.note ? "Edit note" : "Note"}</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete bookmark at ${formatClock(bookmark.positionMs)}`}
        >
          <Trash size={16} />
        </button>
      </div>
      {editing && (
        <form className="bookmark-note-form" onSubmit={submitNote}>
          <input
            name="note"
            defaultValue={bookmark.note || ""}
            maxLength={2000}
            placeholder="What happens here?"
            aria-label="Bookmark note"
          />
          <button type="submit" className="secondary-button">
            Save
          </button>
        </form>
      )}
    </li>
  );
}

function SleepMenu() {
  const playback = usePlayback();
  const detailsRef = useRef<HTMLDetailsElement>(null);

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
        <span aria-live="polite">{sleepLabel(playback.sleepMode)}</span>
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

function sleepLabel(mode: ReturnType<typeof usePlayback>["sleepMode"]): string {
  if (!mode) return "Sleep timer";
  if (mode.kind === "chapter") return "End of chapter";
  return `${Math.max(1, Math.ceil((mode.endsAt - Date.now()) / 60_000))} min left`;
}
