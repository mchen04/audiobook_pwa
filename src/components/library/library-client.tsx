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
import { memo, useCallback, useDeferredValue, useEffect, useState } from "react";

import { FullPlayer } from "@/components/player/full-player";
import { useActiveUserId } from "@/components/use-active-user";
import type { LibraryBook } from "@/domain/library";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationRounded } from "@/lib/format-time";
import { markLaunchPainted } from "@/lib/launch-revalidation";
import type { OfflineBook } from "@/lib/offline/db";
import { asOfflinePlayerBook } from "@/lib/offline/library";
import { listBookIdsWithTranscripts } from "@/lib/offline/transcript-store";

import { UploadBanners, useMp3Import } from "./library-upload";
import { type SortOrder, type StatusFilter } from "./library-view";
import { usePageWindow, useSeedFollowingToggle } from "./use-derived-reset";
import { type DeviceIndex, useLibraryBooks } from "./use-library-books";
import { useOfflineBookRoute } from "./use-offline-book-route";

type LibraryClientProps = {
  /** Present only when the server rendered this page; absent on a warm launch. */
  userId?: string;
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

/**
 * Every `Link` below carries `prefetch={false}`, deliberately.
 *
 * Left on, a launch quietly fires an RSC request per visible card the moment
 * hydration finishes — a server round trip with a `requireSession()` and a full
 * book query behind each one, for pages the user never asked for. That is the
 * network back on the launch path by the side door, competing with the one sync
 * the design does sanction, and on a slow connection it lands in the middle of
 * the next launch. The device already holds everything this screen needs; a
 * book page is fetched when the user actually opens one.
 */

export function LibraryClient({ userId: serverUserId }: LibraryClientProps) {
  const userId = useActiveUserId(serverUserId);

  const [query, setQuery] = useState("");
  // The input stays controlled and immediate; the listing reads the deferred
  // value, so a slow re-read never holds a keystroke back from the screen.
  const deferredQuery = useDeferredValue(query);
  const [status, setStatus] = useState<StatusFilter>("all");
  // The header's Downloads link is `?device=1`, so the facet follows the URL
  // until the user works the chip themselves — and follows it again the next
  // time that link is used.
  const facetFromUrl = useSearchParams().get("device") === "1";
  const [onDevice, setOnDevice] = useSeedFollowingToggle(facetFromUrl);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOrder>("activity");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [readAlongIds, setReadAlongIds] = useState<Set<string>>(new Set());
  const { bookId: fallbackBookId, leavePlayer } = useOfflineBookRoute();

  const { snapshot, preparing, firstSyncStatus, unavailable, reload, retry, removeDownload } =
    useLibraryBooks(userId, { query: deferredQuery, status, tag: activeTag, sort, onDevice });

  // The page owns its one alert region; the import hook and the download
  // remover both report into it.
  const [error, setError] = useState<string | null>(null);
  const { fileInput, upload, chooseFile } = useMp3Import(userId, reload, setError);

  const books = snapshot?.books || [];
  const device: DeviceIndex = snapshot?.device || EMPTY_DEVICE_INDEX;
  const playing = fallbackBookId ? device.get(fallbackBookId) || null : null;
  const filterKey = JSON.stringify([deferredQuery, status, activeTag, sort, onDevice]);
  const { pages, showMore } = usePageWindow(filterKey);
  // A first launch on a device that has never synced holds an empty mirror, and
  // "you have no books" would simply be false there. Section 12's upgrading
  // device is unaffected: it has downloads, so `libraryTotal` is not zero and
  // its books render straight away.
  //
  // This stays true for as long as the device has not completed a pull — a
  // failed or stalled first pull no longer resolves it, because a device that
  // has not been told what the account holds cannot report what the account
  // holds. There is no timeout after which a guess becomes a fact.
  const firstSync = !!snapshot && snapshot.libraryTotal === 0 && preparing;
  // The launch benchmark measures the moment this attribute lands in the DOM.
  // It is a contract: it may only be set when the user's REAL library is on
  // screen — actual book cards, or the genuine "no books yet" state. A skeleton,
  // a spinner, a placeholder grid, a filtered "no matching books" view, or the
  // first-sync notice below must never carry it, or the benchmark starts
  // measuring an empty box and the sub-500ms bar stops meaning anything.
  // `snapshot` is null until this device's own library has been read, so
  // nothing below renders before then.
  const launchReady = !snapshot
    ? undefined
    : snapshot.libraryTotal === 0
      ? firstSync
        ? undefined
        : "empty"
      : books.length > 0
        ? "books"
        : undefined;

  // Revalidation is allowed to reach for the network only once this has
  // happened; see `lib/launch-revalidation.ts`.
  useEffect(() => {
    if (launchReady) markLaunchPainted();
  }, [launchReady]);

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
    [removeDownload, setError],
  );

  if (playing) {
    return (
      <FullPlayer
        playerBook={asOfflinePlayerBook(playing)}
        offlineMode
        backLabel="Library"
        onBack={leavePlayer}
      />
    );
  }

  // `snapshot` is null until this device's own library has been read, so
  // nothing below — and no readiness marker — renders before then.
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

  // The device has nothing mirrored and has never completed a pull. Saying
  // "bring your first audiobook" here would be a guess presented as a fact, so
  // it says what is actually happening — and carries no readiness marker, in
  // either of its two wordings.
  if (firstSync) {
    // A pull that has not answered yet has not failed. Only one of these three
    // says the device could not reach the account, and none of them claims to
    // know what the account holds.
    if (firstSyncStatus === "unreachable") {
      return (
        <section className="library-content" aria-labelledby="library-title">
          <div className="no-results">
            <CloudSlash size={30} weight="duotone" aria-hidden="true" />
            <h2 id="library-title">This device has not seen your library yet</h2>
            <p>
              Hark could not reach your account from this device, so it cannot tell you what is in
              your library. Nothing is lost — this finishes as soon as there is a connection.
            </p>
            <button type="button" className="secondary-button" onClick={retry}>
              Try again
            </button>
          </div>
        </section>
      );
    }
    return (
      <section className="library-content" aria-labelledby="library-title" aria-busy="true">
        <div className="no-results">
          <BookOpenText size={30} weight="duotone" aria-hidden="true" />
          <h2 id="library-title">Setting up your library</h2>
          <p>
            Hark is bringing this account&apos;s books onto this device for the first time.
            {firstSyncStatus === "slow" && " This one is taking longer than usual."}
          </p>
        </div>
      </section>
    );
  }

  const shown = books.slice(0, pages * PAGE_SIZE);
  const continueBook = snapshot.continueBook;
  const continueRecord = continueBook ? device.get(continueBook.id) : undefined;

  return (
    <>
      {fileInput}

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
              prefetch={false}
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
              onClick={() => setOnDevice(!onDevice)}
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
                  setOnDevice(false);
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          {books.length > shown.length && (
            <div className="library-more">
              <button type="button" className="secondary-button" onClick={showMore}>
                Load more books
              </button>
              <small>
                Showing {shown.length} of {books.length} matching books.
              </small>
            </div>
          )}
        </section>
      )}

      <UploadBanners upload={upload} error={error} onDismissError={() => setError(null)} />
    </>
  );
}

const EMPTY_DEVICE_INDEX: DeviceIndex = new Map();

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
      <Link
        href={`/books/${book.id}`}
        className="book-cover"
        prefetch={false}
        tabIndex={-1}
        aria-hidden="true"
      >
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
        <Link href={`/books/${book.id}`} className="book-title" prefetch={false}>
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
        {!record && (
          <p className="book-device book-device-missing" title={MISSING_MEDIA_HINT}>
            <CloudSlash size={14} aria-hidden="true" />
            <span>Not on this device — re-import the MP3 to listen</span>
          </p>
        )}
        {/* Duration, progress and what the audio costs this device are one
            line, not three. On a two-column phone grid the old standalone
            "On this device · 5.4 GB" row wrapped and pushed the progress bar
            most of a card-height further down; the facet chip and the icon
            here already say what "on this device" meant, so only the number
            it carried is worth the room. */}
        <div className="book-progress-copy">
          <span className="book-progress-status">
            {book.durationMs ? `${formatDurationRounded(book.durationMs)} • ` : ""}
            {book.completed ? "Finished" : percent ? `${percent}%` : "Not started"}
          </span>
          {record && (
            <>
              <span className="book-device-size">
                <DownloadSimple size={13} aria-hidden="true" />
                <span>{formatBytes(record.byteSize)}</span>
                {/* The number alone means nothing read aloud, and the leading
                    space keeps the element's text reading as one phrase. */}
                <span className="visually-hidden">{" on this device"}</span>
              </span>
              <button
                type="button"
                className="book-device-remove"
                aria-label={`Remove download of ${book.title}`}
                title="Remove the audio from this device. The book, its progress and its history stay."
                onClick={() => onRemoveDownload(book.id)}
              >
                <Trash size={14} aria-hidden="true" />
              </button>
            </>
          )}
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
            prefetch={false}
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
