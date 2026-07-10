"use client";

import { UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { ChangeEvent, useEffect, useRef, useState } from "react";

import type { BookDetails } from "@/components/book/book-details-dialog";
import { FullPlayer } from "@/components/player/full-player";
import type { Bookmark, NextInCollection, PlayerBook } from "@/domain/player";
import { fileFingerprint } from "@/lib/local-import";
import { getOfflineBook, storeLocalBookMedia } from "@/lib/offline-library";

type GateState =
  | { phase: "checking" }
  | { phase: "ready"; mediaUrl: string; coverUrl: string | null }
  | { phase: "missing" }
  | { phase: "attaching" };

/**
 * Audio bytes live only on the user's devices. Before the player mounts, this
 * gate resolves the book's media from this device's store; when the book was
 * imported elsewhere, it asks for the original MP3 and verifies it is the
 * same file before storing it here.
 */
export function LocalMediaGate({
  userId,
  playerBook,
  mediaFingerprint,
  byteSize,
  initialBookmarks,
  autoplay,
  details,
  nextInCollection,
}: {
  userId: string;
  playerBook: PlayerBook;
  mediaFingerprint: string | null;
  byteSize: number | null;
  initialBookmarks: Bookmark[];
  autoplay: boolean;
  details: BookDetails | null;
  nextInCollection: NextInCollection | null;
}) {
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void getOfflineBook(userId, playerBook.id)
      .then((record) => {
        if (!active) return;
        if (record) {
          setState({
            phase: "ready",
            mediaUrl: record.offlineMediaUrl,
            coverUrl: record.offlineCoverUrl,
          });
        } else {
          setState({ phase: "missing" });
        }
      })
      .catch(() => active && setState({ phase: "missing" }));
    return () => {
      active = false;
    };
  }, [userId, playerBook.id]);

  async function attachFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError(null);
    setState({ phase: "attaching" });
    try {
      if (byteSize && file.size !== byteSize) {
        throw new Error(
          `This file is not the one this book was imported from (expected ${formatBytes(byteSize)}).`,
        );
      }
      if (mediaFingerprint && (await fileFingerprint(file)) !== mediaFingerprint) {
        throw new Error("This file's content does not match this book.");
      }
      const record = await storeLocalBookMedia(
        userId,
        {
          id: playerBook.id,
          title: playerBook.title,
          author: playerBook.author,
          durationMs: playerBook.durationMs,
          chapters: playerBook.chapters,
          initialPositionMs: playerBook.initialPositionMs,
          initialPlaybackRate: playerBook.initialPlaybackRate,
          completed: playerBook.completed,
        },
        file,
        null,
      );
      setState({
        phase: "ready",
        mediaUrl: record.offlineMediaUrl,
        coverUrl: record.offlineCoverUrl,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be attached.");
      setState({ phase: "missing" });
    }
  }

  if (state.phase === "ready") {
    return (
      <FullPlayer
        playerBook={{ ...playerBook, mediaUrl: state.mediaUrl, coverUrl: state.coverUrl }}
        initialBookmarks={initialBookmarks}
        autoplay={autoplay}
        details={details}
        nextInCollection={nextInCollection}
      />
    );
  }

  return (
    <main className="local-media-gate">
      <section aria-live="polite">
        <h1>{playerBook.title}</h1>
        <p className="gate-author">{playerBook.author}</p>
        {state.phase === "checking" && <p>Checking this device for the audio…</p>}
        {state.phase === "attaching" && <p>Verifying and storing the MP3 on this device…</p>}
        {state.phase === "missing" && (
          <>
            <p>
              The audio for this book is stored on your devices, not in the cloud — and this device
              does not have it yet. Attach the original MP3
              {byteSize ? ` (${formatBytes(byteSize)})` : ""} to listen here. Your reading position
              and bookmarks are already synced.
            </p>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".mp3,audio/mpeg,audio/mp3"
              onChange={attachFile}
              tabIndex={-1}
              aria-label="Attach the book's MP3 file"
            />
            <button
              type="button"
              className="primary-button"
              onClick={() => inputRef.current?.click()}
            >
              <UploadSimple size={17} aria-hidden="true" />
              Attach MP3
            </button>
            {error && <p className="form-error">{error}</p>}
            <p>
              <Link href="/library">Back to library</Link>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}
