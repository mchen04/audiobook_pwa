"use client";

import {
  BookOpenText,
  CloudSlash,
  DownloadSimple,
  MagnifyingGlass,
  Play,
  Rows,
  SquaresFour,
  TextAlignLeft,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { ChangeEvent, memo, useCallback, useEffect, useRef, useState } from "react";

import { FullPlayer } from "@/components/player/full-player";
import { useActiveUserId } from "@/components/use-active-user";
import type { LibraryBook } from "@/domain/library";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationRounded } from "@/lib/format-time";
import { importLocalMp3 } from "@/lib/local-import";
import type { OfflineBook } from "@/lib/offline/db";
import { asOfflinePlayerBook } from "@/lib/offline/library";
import { listBookIdsWithTranscripts } from "@/lib/offline/transcript-store";

import { type SortOrder, type StatusFilter } from "./library-view";
import { type DeviceIndex, useLibraryBooks } from "./use-library-books";

type LibraryClientProps = {
  /** Present only when the server rendered this page; absent on a warm launch. */
  userId?: string;
};

type UploadState = {
  filename: string;
  percent: number;
  stage: string;
};

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "in-progress", label: "In progress" },
  { id: "not-started", label: "Not started" },
  { id: "finished", label: "Finished" },
  { id: "archived", label: "Archived" },
];

/** One page of cards, so a thousand-book library still paints a first screen. */
const PAGE_SIZE = 50;

const MISSING_MEDIA_HINT =
  "The audio for this book lives only on the device that imported it. Re-import the MP3 here to listen.";

const BOOK_PATH = /^\/books\/([0-9a-fA-F-]{36})\/?$/;

export function LibraryClient({ userId: serverUserId }: LibraryClientProps) {
  const userId = useActiveUserId(serverUserId);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  // The header's Downloads link is `?device=1`, so the facet follows the URL
  // until the user works the chip themselves — and follows it again the next
  // time that link is used.
  const facetFromUrl = useSearchParams().get("device") === "1";
  const [facetChoice, setFacetChoice] = useState<{ from: boolean; on: boolean } | null>(null);
  const onDevice = facetChoice?.from === facetFromUrl ? facetChoice.on : facetFromUrl;
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOrder>("activity");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readAlongIds, setReadAlongIds] = useState<Set<string>>(new Set());
  /**
   * The service worker answers a navigation it cannot fetch with the cached
   * library document, whatever URL was asked for. Sitting at a `/books/` URL
   * therefore means the user asked to play a book and the network could not
   * answer — so this device's own copy answers instead. Online the book page
   * renders and this component never mounts at that URL, which is why opening
   * a book needs no "am I online?" question anywhere.
   */
  const [fallbackBookId, setFallbackBookId] = useState(bookIdFromUrl);
  const [pagination, setPagination] = useState({ key: "", pages: 1 });

  const { snapshot, unavailable, reload, retry, removeDownload } = useLibraryBooks(userId, {
    query,
    status,
    tag: activeTag,
    sort,
    onDevice,
  });

  const books = snapshot?.books || [];
  const device: DeviceIndex = snapshot?.device || EMPTY_DEVICE_INDEX;
  const playing = fallbackBookId ? device.get(fallbackBookId) || null : null;
  // A filter change resets the page window without an effect: the window is
  // simply not carried across a different set of filters.
  const filterKey = JSON.stringify([query, status, activeTag, sort, onDevice]);
  const pages = pagination.key === filterKey ? pagination.pages : 1;

  useEffect(() => {
    if (!userId) return;
    let active = true;
    void listBookIdsWithTranscripts(userId)
      .then((ids) => {
        if (active) setReadAlongIds(ids);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId]);

  const forgetDownload = useCallback(
    async (bookId: string) => {
      const removed = await removeDownload(bookId);
      if (!removed) {
        setError("The download could not be removed right now. It will retry automatically.");
      }
    },
    [removeDownload],
  );

  function chooseFile() {
    setError(null);
    inputRef.current?.click();
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".mp3")) {
      setError("Choose an MP3 file. Other audiobook formats are not supported.");
      return;
    }
    if (!userId) return;

    setError(null);
    setUpload({ filename: file.name, percent: 0, stage: "Starting" });
    try {
      await importLocalMp3(userId, file, (percent, stage) =>
        setUpload({ filename: file.name, percent, stage }),
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The MP3 could not be imported.");
    } finally {
      setUpload(null);
    }
  }

  if (playing) {
    return (
      <FullPlayer
        playerBook={asOfflinePlayerBook(playing)}
        offlineMode
        backLabel="Library"
        onBack={() => {
          window.history.replaceState(null, "", "/library");
          setFallbackBookId(null);
        }}
      />
    );
  }

  // The launch benchmark measures the moment this attribute lands in the DOM.
  // It is a contract: it may only be set when the user's REAL library is on
  // screen — actual book cards, or the genuine "no books yet" state. A skeleton,
  // a spinner, a placeholder grid, or a filtered "no matching books" view must
  // never carry it, or the benchmark starts measuring an empty box and the
  // sub-500ms bar stops meaning anything. `snapshot` is null until this
  // device's own library has been read, so nothing below renders before then.
  if (!snapshot) {
    return unavailable ? (
      <section className="library-content">
        <div className="no-results">
          <WarningCircle size={30} weight="duotone" aria-hidden="true" />
          <h2>Your library is temporarily unavailable</h2>
          <p>Hark could not open this device&apos;s storage. Your records are intact.</p>
          <button type="button" className="secondary-button" onClick={retry}>
            Try again
          </button>
        </div>
      </section>
    ) : null;
  }

  const launchReady =
    snapshot.libraryTotal === 0 ? "empty" : books.length > 0 ? "books" : undefined;
  const shown = books.slice(0, pages * PAGE_SIZE);
  const continueBook = snapshot.continueBook;
  const continueRecord = continueBook ? device.get(continueBook.id) : undefined;

  return (
    <>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".mp3,audio/mpeg,audio/mp3"
        onChange={handleFile}
        tabIndex={-1}
        aria-label="Choose an MP3 file to import"
      />

      {snapshot.libraryTotal === 0 ? (
        <section
          className="empty-library"
          data-launch-ready={launchReady}
          aria-labelledby="library-title"
          aria-busy={!!upload}
          inert={upload ? true : undefined}
        >
          <div className="empty-library-art" aria-hidden="true">
            <BookOpenText size={54} weight="duotone" />
          </div>
          <p className="library-kicker">Your private library</p>
          <h1 id="library-title">Bring your first audiobook.</h1>
          <p>
            Choose the chaptered MP3 from Epub Listener. Hark keeps its chapters and remembers your
            place.
          </p>
          <button type="button" className="primary-button" onClick={chooseFile} disabled={!!upload}>
            <UploadSimple size={20} weight="bold" aria-hidden="true" />
            <span>{upload ? "Importing" : "Choose MP3"}</span>
          </button>
          <small>MP3 only. Your library is visible only to you.</small>
        </section>
      ) : (
        <section
          className="library-content"
          data-launch-ready={launchReady}
          aria-labelledby="library-title"
          aria-busy={!!upload}
          inert={upload ? true : undefined}
        >
          <div className="library-heading">
            <h1 id="library-title">Library</h1>
            <button
              type="button"
              className="primary-button"
              onClick={chooseFile}
              disabled={!!upload}
            >
              <UploadSimple size={20} weight="bold" aria-hidden="true" />
              <span>{upload ? "Importing" : "Add MP3"}</span>
            </button>
          </div>

          {continueBook && (
            <Link
              href={`/books/${continueBook.id}`}
              className="continue-card"
              aria-label={`Continue listening ${continueBook.title}`}
            >
              <span className="book-cover continue-cover" aria-hidden="true">
                <BookCover book={continueBook} coverUrl={coverUrlFor(continueRecord)} />
              </span>
              <span className="continue-copy">
                <small>Continue listening</small>
                <strong>{continueBook.title}</strong>
                <span>
                  {progressPercent(continueBook)}% · {remainingLabel(continueBook)}
                  {continueRecord ? "" : " · Not on this device"}
                </span>
              </span>
              {continueRecord ? (
                <span className="continue-play" aria-hidden="true">
                  <Play size={24} weight="fill" />
                </span>
              ) : (
                <span className="continue-play continue-unavailable" title={MISSING_MEDIA_HINT}>
                  <CloudSlash size={22} aria-hidden="true" />
                  <span className="visually-hidden">Not on this device</span>
                </span>
              )}
            </Link>
          )}

          <div className="library-tools">
            <label className="search-field">
              <MagnifyingGlass size={19} aria-hidden="true" />
              <span className="visually-hidden">Search your library</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Search library"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                  }}
                  aria-label="Clear search"
                >
                  <X size={17} aria-hidden="true" />
                </button>
              )}
            </label>
            <label className="sort-field">
              <span className="visually-hidden">Sort books</span>
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as SortOrder);
                }}
              >
                <option value="activity">Recent activity</option>
                <option value="added">Recently added</option>
                <option value="title">Title A–Z</option>
                <option value="author">Author A–Z</option>
              </select>
            </label>
            <div className="view-switch" aria-label="Library view">
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <SquaresFour size={19} weight={view === "grid" ? "fill" : "regular"} />
              </button>
              <button
                type="button"
                aria-label="List view"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <Rows size={19} weight={view === "list" ? "bold" : "regular"} />
              </button>
            </div>
          </div>

          <div className="library-filters" role="group" aria-label="Filter your library">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className="filter-chip"
                aria-pressed={status === filter.id}
                onClick={() => {
                  setStatus(filter.id);
                }}
              >
                {filter.label}
              </button>
            ))}
            {/* Downloads are a facet of the one library, not a second screen. */}
            <button
              type="button"
              className="filter-chip filter-chip-device"
              aria-pressed={onDevice}
              onClick={() => setFacetChoice({ from: facetFromUrl, on: !onDevice })}
            >
              <DownloadSimple size={15} weight="bold" aria-hidden="true" />
              <span>On this device</span>
              {device.size > 0 && <span className="filter-chip-count">{device.size}</span>}
            </button>
            {snapshot.tags.map((tag) => (
              <button
                key={`tag-${tag}`}
                type="button"
                className="filter-chip filter-chip-tag"
                aria-pressed={activeTag === tag}
                onClick={() => {
                  setActiveTag((current) => (current === tag ? null : tag));
                }}
              >
                #{tag}
              </button>
            ))}
          </div>

          {shown.length ? (
            <div className={`book-grid ${view === "list" ? "book-grid-list" : ""}`}>
              {shown.map((book) => (
                <BookItem
                  book={book}
                  key={book.id}
                  compact={view === "list"}
                  record={device.get(book.id)}
                  hasReadAlong={readAlongIds.has(book.id)}
                  onRemoveDownload={forgetDownload}
                />
              ))}
            </div>
          ) : (
            <div className="no-results">
              <MagnifyingGlass size={30} weight="duotone" aria-hidden="true" />
              <h2>
                {onDevice && device.size === 0 ? "Nothing downloaded yet" : "No matching books"}
              </h2>
              <p>
                {onDevice && device.size === 0
                  ? "Open a book and choose Download to keep its audio on this device."
                  : "Try another search, status, or tag."}
              </p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setActiveTag(null);
                  setFacetChoice({ from: facetFromUrl, on: false });
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          {books.length > shown.length && (
            <div className="library-more">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPagination({ key: filterKey, pages: pages + 1 })}
              >
                Load more books
              </button>
              <small>
                Showing {shown.length} of {books.length} matching books.
              </small>
            </div>
          )}
        </section>
      )}

      {upload && (
        <div className="upload-status" role="status" aria-live="polite">
          <div>
            <span>
              {upload.stage} · {upload.filename}
            </span>
            <strong>{upload.percent}%</strong>
          </div>
          <progress value={upload.percent} max={100} aria-label={`Importing ${upload.filename}`} />
        </div>
      )}

      {error && (
        <div className="upload-error" role="alert">
          <WarningCircle size={21} weight="fill" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

const EMPTY_DEVICE_INDEX: DeviceIndex = new Map();

/** The book this document was asked for, when the URL names one. */
function bookIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return BOOK_PATH.exec(window.location.pathname)?.[1] || null;
}

function coverUrlFor(record: OfflineBook | undefined): string | undefined {
  return record ? record.offlineCoverThumbUrl || record.offlineCoverUrl || undefined : undefined;
}

function progressPercent(book: LibraryBook): number {
  if (!book.durationMs || !book.positionMs) return 0;
  return Math.min(100, Math.max(0, Math.round((book.positionMs / book.durationMs) * 100)));
}

function remainingLabel(book: LibraryBook): string {
  if (!book.durationMs) return "";
  const remaining = Math.max(0, book.durationMs - (book.positionMs || 0));
  if (remaining < 60_000) return "under a minute left";
  return `${formatDurationRounded(remaining)} left`;
}

function BookCover({ book, coverUrl }: { book: LibraryBook; coverUrl?: string }) {
  if (coverUrl) {
    return (
      <Image
        className="book-cover-art"
        src={coverUrl}
        alt=""
        width={160}
        height={240}
        unoptimized
      />
    );
  }
  const initials = book.title
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <>
      <span>{initials || "AB"}</span>
      <small>MP3</small>
    </>
  );
}

// Memoized so search keystrokes re-render the tools row, not the whole grid.
const BookItem = memo(function BookItem({
  book,
  compact,
  record,
  hasReadAlong,
  onRemoveDownload,
}: {
  book: LibraryBook;
  compact: boolean;
  record?: OfflineBook;
  hasReadAlong?: boolean;
  onRemoveDownload: (bookId: string) => void;
}) {
  const percent = progressPercent(book);

  return (
    <article className="book-item">
      {/* The title link is the card's accessible entry; the cover stays clickable
          without adding a duplicate tab stop. */}
      <Link href={`/books/${book.id}`} className="book-cover" tabIndex={-1} aria-hidden="true">
        <BookCover book={book} coverUrl={coverUrlFor(record)} />
        {hasReadAlong && (
          <span className="book-readalong">
            <TextAlignLeft size={12} aria-hidden="true" />
            Read-along
          </span>
        )}
        {!record && (
          <span className="book-offdevice">
            <CloudSlash size={12} aria-hidden="true" />
            Not on device
          </span>
        )}
      </Link>
      <div className="book-copy">
        <Link href={`/books/${book.id}`} className="book-title">
          {book.title}
        </Link>
        <p>{book.author}</p>
        {book.chapterDiagnostic && (
          <p className="book-diagnostic" title={book.chapterDiagnostic}>
            <WarningCircle size={15} aria-hidden="true" />
            One chapter
          </p>
        )}
        {book.tags.length > 0 && <p className="book-tags">{book.tags.join(" · ")}</p>}
        {record ? (
          <p className="book-device">
            <DownloadSimple size={14} aria-hidden="true" />
            <span>On this device · {formatBytes(record.byteSize)}</span>
            <button
              type="button"
              className="book-device-remove"
              aria-label={`Remove download of ${book.title}`}
              title="Remove the audio from this device. The book, its progress and its history stay."
              onClick={() => onRemoveDownload(book.id)}
            >
              <Trash size={15} aria-hidden="true" />
            </button>
          </p>
        ) : (
          <p className="book-device book-device-missing" title={MISSING_MEDIA_HINT}>
            <CloudSlash size={14} aria-hidden="true" />
            <span>Not on this device — re-import the MP3 to listen</span>
          </p>
        )}
        <div className="book-progress-copy">
          <span>
            {book.durationMs ? `${formatDurationRounded(book.durationMs)} • ` : ""}
            {book.completed ? "Finished" : percent ? `${percent}%` : "Not started"}
          </span>
        </div>
        <div
          className="book-progress"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Listening progress"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
      {compact &&
        (record ? (
          <Link
            href={`/books/${book.id}`}
            className="book-play-button"
            aria-label={`Play ${book.title}`}
          >
            <Play size={19} weight="fill" aria-hidden="true" />
          </Link>
        ) : (
          <span className="book-play-button book-play-unavailable" title={MISSING_MEDIA_HINT}>
            <CloudSlash size={19} aria-hidden="true" />
            <span className="visually-hidden">Not on this device</span>
          </span>
        ))}
    </article>
  );
});
