"use client";

import { ArrowLeft, DownloadSimple, Play, Trash, WifiSlash } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { FullPlayer } from "@/components/player/full-player";
import { PlaybackProvider } from "@/components/player/playback-provider";
import {
  asOfflinePlayerBook,
  listOfflineBooks,
  type OfflineBook,
  removeOfflineBook,
} from "@/lib/offline-library";

type LibraryState =
  { kind: "loading" } | { kind: "signed-out" } | { kind: "ready"; books: OfflineBook[] };

export function OfflineLibrary() {
  const [state, setState] = useState<LibraryState>({ kind: "loading" });
  const [selected, setSelected] = useState<OfflineBook | null>(null);

  useEffect(() => {
    let active = true;
    void initialize();
    return () => {
      active = false;
    };

    async function initialize() {
      const userId = localStorage.getItem("chapterline:active-user");
      if (!userId) {
        if (active) setState({ kind: "signed-out" });
        return;
      }
      const books = await listOfflineBooks(userId);
      if (active) setState({ kind: "ready", books });
    }
  }, []);

  if (selected) {
    return (
      <PlaybackProvider userId={selected.userId}>
        <main className="app-page offline-player-shell">
          <header className="app-header">
            <BrandMark />
            <span className="offline-badge">
              <WifiSlash size={17} aria-hidden="true" />
              Offline
            </span>
          </header>
          <FullPlayer
            playerBook={asOfflinePlayerBook(selected)}
            initialBookmarks={[]}
            offlineMode
            backHref="/offline"
            backLabel="Downloads"
          />
        </main>
      </PlaybackProvider>
    );
  }

  return (
    <main className="offline-page">
      <header className="offline-header">
        <BrandMark />
        <Link href="/library" className="icon-text-button">
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Library</span>
        </Link>
      </header>
      <section className="offline-library" aria-labelledby="downloads-title">
        <div className="offline-heading">
          <p className="library-kicker">Saved on this device</p>
          <h1 id="downloads-title">Downloads</h1>
          <p>Listen without a connection. Removing a download never removes the book itself.</p>
        </div>

        {state.kind === "loading" && <p role="status">Opening downloaded books…</p>}
        {state.kind === "signed-out" && (
          <div className="offline-empty">
            <WifiSlash size={36} weight="duotone" aria-hidden="true" />
            <h2>No active private library</h2>
            <p>Connect once and sign in to unlock this device’s downloads.</p>
            <Link href="/login" className="secondary-button">
              Sign in when online
            </Link>
          </div>
        )}
        {state.kind === "ready" && state.books.length === 0 && (
          <div className="offline-empty">
            <DownloadSimple size={36} weight="duotone" aria-hidden="true" />
            <h2>No downloaded books yet</h2>
            <p>Open a book and choose Download before going offline.</p>
            <Link href="/library" className="secondary-button">
              Open library
            </Link>
          </div>
        )}
        {state.kind === "ready" && state.books.length > 0 && (
          <div className="offline-book-list">
            {state.books.map((record) => (
              <article key={record.key}>
                <button
                  type="button"
                  className="offline-book-open"
                  onClick={() => setSelected(record)}
                  aria-label={`Open ${record.book.title}`}
                >
                  <span className="offline-cover">
                    {record.book.title.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{record.book.title}</strong>
                    <small>{record.book.author}</small>
                    <small>{formatBytes(record.byteSize)}</small>
                  </span>
                  <Play size={21} weight="fill" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="offline-remove"
                  onClick={() => removeDownload(record)}
                  aria-label={`Remove download of ${record.book.title}`}
                >
                  <Trash size={18} aria-hidden="true" />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );

  async function removeDownload(record: OfflineBook) {
    await removeOfflineBook(record.userId, record.book.id);
    setState((current) =>
      current.kind === "ready"
        ? { ...current, books: current.books.filter((book) => book.key !== record.key) }
        : current,
    );
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
