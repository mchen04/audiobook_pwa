"use client";

import {
  BookOpenText,
  MagnifyingGlass,
  Play,
  Rows,
  SquaresFour,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import Image from "next/image";
import { ChangeEvent, memo, useEffect, useRef, useState } from "react";

import type { LibraryBook } from "@/domain/library";
import { formatDurationRounded } from "@/lib/format-time";
import { importLocalMp3 } from "@/lib/local-import";
import { listOfflineCoverUrls } from "@/lib/offline/library";
import type { LibraryPage } from "@/lib/wire";

import { type SortOrder, type StatusFilter } from "./library-view";
import { useLibraryBooks } from "./use-library-books";

type LibraryClientProps = {
  userId: string;
  initialPage: LibraryPage;
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

export function LibraryClient({ userId, initialPage }: LibraryClientProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOrder>("activity");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localCovers, setLocalCovers] = useState<Record<string, string>>({});
  const [coverRefresh, setCoverRefresh] = useState(0);
  const { page, reload, loadMore, loading } = useLibraryBooks(initialPage, {
    query,
    status,
    tag: activeTag,
    sort,
  });
  const books = page.books;

  // The cover map is filter-independent; it changes only when a book is
  // imported on this device, so searches and pagination never re-read it.
  useEffect(() => {
    let active = true;
    void listOfflineCoverUrls(userId)
      .then((covers) => {
        if (active) setLocalCovers(covers);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId, coverRefresh]);

  const allTags = page.tags;
  const continueBook = page.continueBook;

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

    setError(null);
    setUpload({ filename: file.name, percent: 0, stage: "Starting" });
    try {
      await importLocalMp3(userId, file, (percent, stage) =>
        setUpload({ filename: file.name, percent, stage }),
      );
      setCoverRefresh((current) => current + 1);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The MP3 could not be imported.");
    } finally {
      setUpload(null);
    }
  }

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

      {page.libraryTotal === 0 ? (
        <section
          className="empty-library"
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
                <BookCover book={continueBook} coverUrl={localCovers[continueBook.id]} />
              </span>
              <span className="continue-copy">
                <small>Continue listening</small>
                <strong>{continueBook.title}</strong>
                <span>
                  {progressPercent(continueBook)}% · {remainingLabel(continueBook)}
                </span>
              </span>
              <span className="continue-play" aria-hidden="true">
                <Play size={24} weight="fill" />
              </span>
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
            {allTags.map((tag) => (
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

          {books.length ? (
            <div className={`book-grid ${view === "list" ? "book-grid-list" : ""}`}>
              {books.map((book) => (
                <BookItem
                  book={book}
                  key={book.id}
                  compact={view === "list"}
                  coverUrl={localCovers[book.id]}
                />
              ))}
            </div>
          ) : (
            <div className="no-results">
              <MagnifyingGlass size={30} weight="duotone" aria-hidden="true" />
              <h2>No matching books</h2>
              <p>Try another search, status, or tag.</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setQuery("");
                  setStatus("all");
                  setActiveTag(null);
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          {page.nextCursor && (
            <div className="library-more">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void loadMore()}
                disabled={loading}
              >
                {loading ? "Loading" : "Load more books"}
              </button>
              <small>
                Showing {books.length} of {page.total} matching books.
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
  coverUrl,
}: {
  book: LibraryBook;
  compact: boolean;
  coverUrl?: string;
}) {
  const percent = progressPercent(book);

  return (
    <article className="book-item">
      {/* The title link is the card's accessible entry; the cover stays clickable
          without adding a duplicate tab stop. */}
      <Link href={`/books/${book.id}`} className="book-cover" tabIndex={-1} aria-hidden="true">
        <BookCover book={book} coverUrl={coverUrl} />
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
      {compact && (
        <Link
          href={`/books/${book.id}`}
          className="book-play-button"
          aria-label={`Play ${book.title}`}
        >
          <Play size={19} weight="fill" aria-hidden="true" />
        </Link>
      )}
    </article>
  );
});
