"use client";

import {
  ArrowClockwise,
  ArrowLeft,
  DownloadSimple,
  Play,
  Trash,
  WifiSlash,
} from "@phosphor-icons/react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BrandMark } from "@/components/brand-mark";
import { formatBytes } from "@/lib/format-bytes";
import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { FullPlayer } from "@/components/player/full-player";
import { PlaybackProvider } from "@/components/player/playback-provider";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { asOfflinePlayerBook, listOfflineBooks } from "@/lib/offline/library";
import type { OfflineBook } from "@/lib/offline/db";

type LibraryState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "unavailable" }
  | { kind: "ready"; books: OfflineBook[] };

export function OfflineLibrary() {
  const [state, setState] = useState<LibraryState>({ kind: "loading" });
  const [selected, setSelected] = useState<OfflineBook | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void initialize();
    return () => {
      active = false;
    };

    async function initialize() {
      const userId = localStorage.getItem(ACTIVE_USER_KEY);
      if (!userId) {
        if (active) setState({ kind: "signed-out" });
        return;
      }
      try {
        const books = await listOfflineBooks(userId);
        if (active) setState({ kind: "ready", books });
      } catch {
        if (active) setState({ kind: "unavailable" });
      }
    }
  }, [loadAttempt]);

  if (selected) {
    return (
      <PlaybackProvider userId={selected.userId}>
        <main className="app-page offline-player-shell">
          {/* Collapses on phones like the online player's header, so the
              one-screen player height math holds. */}
          <header className="app-header app-header-collapsible">
            <BrandMark />
            <span className="offline-badge">
              <WifiSlash size={17} aria-hidden="true" />
              Offline
            </span>
          </header>
          <FullPlayer
            playerBook={asOfflinePlayerBook(selected)}
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
        {state.kind === "unavailable" && (
          <div className="offline-empty">
            <WifiSlash size={36} weight="duotone" aria-hidden="true" />
            <h2>Downloads are temporarily unavailable</h2>
            <p>Hark could not open this device&apos;s saved audio. Your records are intact.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setState({ kind: "loading" });
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              <ArrowClockwise size={18} aria-hidden="true" />
              Try again
            </button>
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
        {removeError && (
          <p role="alert" className="form-error">
            {removeError}
          </p>
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
                    {record.offlineCoverThumbUrl || record.offlineCoverUrl ? (
                      <Image
                        src={(record.offlineCoverThumbUrl || record.offlineCoverUrl)!}
                        alt=""
                        width={96}
                        height={116}
                        unoptimized
                      />
                    ) : (
                      record.book.title.slice(0, 2).toUpperCase()
                    )}
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
    setRemoveError(null);
    try {
      await removeOfflineBook(record.userId, record.book.id);
    } catch {
      // The deletion is journaled before any bytes move, so it retries
      // automatically on the next load.
      setRemoveError("The download could not be removed right now. It will retry automatically.");
      return;
    }
    setState((current) =>
      current.kind === "ready"
        ? { ...current, books: current.books.filter((book) => book.key !== record.key) }
        : current,
    );
  }
}
