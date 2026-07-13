"use client";

import { ArrowClockwise, Trash, UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import type { BookDetails } from "@/components/book/book-details-dialog";
import { FullPlayer } from "@/components/player/full-player";
import type { NextInCollection, PlaybackHistorySnapshot, PlayerBook } from "@/domain/player";
import { type MediaFingerprintKind, fingerprintMedia } from "@/lib/media-fingerprint";
import { parseLocalMp3 } from "@/lib/local-import";
import { getOfflineBook, removeOfflineBook, storeLocalBookMedia } from "@/lib/offline-library";
import { clearPlaybackHistoryForBook } from "@/lib/playback-history";

type GateState =
  | { phase: "checking" }
  | { phase: "ready"; mediaUrl: string; coverUrl: string | null }
  | { phase: "missing" }
  | { phase: "unavailable" }
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
  mediaFingerprintKind,
  byteSize,
  historySnapshot,
  autoplay,
  details,
  nextInCollection,
}: {
  userId: string;
  playerBook: PlayerBook;
  mediaFingerprint: string | null;
  mediaFingerprintKind: MediaFingerprintKind | null;
  byteSize: number | null;
  historySnapshot: PlaybackHistorySnapshot;
  autoplay: boolean;
  details: BookDetails | null;
  nextInCollection: NextInCollection | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<GateState>({ phase: "checking" });
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const readyMediaUrl = state.phase === "ready" ? state.mediaUrl : null;
  const readyCoverUrl = state.phase === "ready" ? state.coverUrl : null;
  const resolvedPlayerBook = useMemo(
    () =>
      readyMediaUrl ? { ...playerBook, mediaUrl: readyMediaUrl, coverUrl: readyCoverUrl } : null,
    [playerBook, readyCoverUrl, readyMediaUrl],
  );

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
      .catch(() => active && setState({ phase: "unavailable" }));
    return () => {
      active = false;
    };
  }, [userId, playerBook.id, checkAttempt]);

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
      if (
        mediaFingerprint &&
        mediaFingerprintKind &&
        (await fingerprintMedia(file, mediaFingerprintKind)) !== mediaFingerprint
      ) {
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
          initialProgressOccurredAt: playerBook.initialProgressOccurredAt,
          initialPlaybackRate: playerBook.initialPlaybackRate,
          completed: playerBook.completed,
        },
        file,
        (await parseLocalMp3(file)).artwork,
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

  // The book must stay deletable even when this device lacks the audio,
  // otherwise a book imported elsewhere could never be removed from here.
  async function deleteBook() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/books/${playerBook.id}`, { method: "DELETE" }).catch(
      () => null,
    );
    if (!response?.ok) {
      setDeleting(false);
      setConfirmingDelete(false);
      setError("The book could not be deleted. Check your connection and try again.");
      return;
    }
    window.dispatchEvent(new Event("chapterline:unload-player"));
    await clearPlaybackHistoryForBook(userId, playerBook.id).catch(() => undefined);
    await removeOfflineBook(userId, playerBook.id).catch(() => {
      setError("The book was deleted, but device cleanup will retry automatically.");
    });
    router.push("/library");
    router.refresh();
  }

  if (resolvedPlayerBook) {
    return (
      <FullPlayer
        playerBook={resolvedPlayerBook}
        historySnapshot={historySnapshot}
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
        {state.phase === "unavailable" && (
          <>
            <p>
              Hark could not access this device&apos;s saved audio. This can be temporary; retry
              before attaching the MP3 again.
            </p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setState({ phase: "checking" });
                setError(null);
                setCheckAttempt((attempt) => attempt + 1);
              }}
            >
              <ArrowClockwise size={18} aria-hidden="true" />
              Try again
            </button>
            <p>
              <Link href="/library">Back to library</Link>
            </p>
          </>
        )}
        {state.phase === "missing" && (
          <>
            <p>
              The audio for this book is stored on your devices, not in the cloud — and this device
              does not currently have it. Attach the original MP3
              {byteSize ? ` (${formatBytes(byteSize)})` : ""} to listen here. Your reading position
              and playback history are already synced.
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
            <div className="gate-danger">
              <button
                type="button"
                className="danger-button"
                onClick={deleteBook}
                disabled={deleting}
              >
                <Trash size={17} aria-hidden="true" />
                {deleting
                  ? "Deleting"
                  : confirmingDelete
                    ? "Tap again to permanently delete"
                    : "Delete this book"}
              </button>
              <p className="details-hint">
                Removes the book, its progress, and playback history from your library everywhere.
              </p>
            </div>
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
