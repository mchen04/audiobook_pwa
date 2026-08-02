"use client";

import { RefObject, useCallback, useEffect, useState } from "react";

import {
  PLAYBACK_HISTORY_LIMIT,
  type PlaybackAction,
  type PlaybackHistoryEntry,
  type PlaybackHistorySnapshot,
} from "@/domain/playback-history";
import type { PlayerBook } from "@/domain/player";
import {
  loadPlaybackHistory,
  replayPlaybackHistory,
  storePlaybackAction,
} from "@/lib/playback-history";

/**
 * The playback-history log: optimistic capture of every transport action, the
 * per-book hydration merge, and the replay of entries queued while offline.
 * The provider decides WHEN things happen; this hook owns what the history
 * list shows and how an entry survives (or is rolled back from) storage.
 */
export function usePlaybackHistoryLog(
  userId: string,
  audioRef: RefObject<HTMLAudioElement | null>,
  activeBookRef: RefObject<PlayerBook | null>,
) {
  const [history, setHistory] = useState<PlaybackHistoryEntry[]>([]);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);

  const recordAction = useCallback(
    (
      action: PlaybackAction,
      positionMs?: number,
      previousPositionMs: number | null = null,
      description: string | null = null,
    ) => {
      const activeBook = activeBookRef.current;
      const audio = audioRef.current;
      if (!activeBook || !audio) return;
      const now = new Date().toISOString();
      const entry: PlaybackHistoryEntry = {
        id: crypto.randomUUID(),
        action,
        positionMs: Math.round(positionMs ?? audio.currentTime * 1000),
        previousPositionMs: previousPositionMs === null ? null : Math.round(previousPositionMs),
        playbackRate: audio.playbackRate || 1,
        description,
        occurredAt: now,
        recordedAt: now,
      };
      setHistory((current) => [entry, ...current].slice(0, PLAYBACK_HISTORY_LIMIT));
      void storePlaybackAction(userId, activeBook.id, entry)
        .then((result) => {
          if (result === "stored") {
            setHistoryNotice(null);
            return;
          }
          setHistory((current) => current.filter((item) => item.id !== entry.id));
          if (result === "unavailable") {
            setHistoryNotice("Playback history is unavailable on this device.");
          }
        })
        .catch(() => {
          setHistory((current) => current.filter((item) => item.id !== entry.id));
          setHistoryNotice("Playback history is unavailable on this device.");
        });
    },
    [activeBookRef, audioRef, userId],
  );

  /** Merge the server's (or a snapshot's) entries under what was captured locally. */
  const hydrateHistory = useCallback(
    (bookId: string, historySnapshot?: PlaybackHistorySnapshot) => {
      void loadPlaybackHistory(userId, bookId, historySnapshot)
        .catch(() => historySnapshot?.entries || [])
        .then((entries) => {
          if (activeBookRef.current?.id !== bookId) return;
          setHistory((current) =>
            [...current, ...entries]
              .filter(
                (entry, index, all) => all.findIndex((item) => item.id === entry.id) === index,
              )
              .slice(0, PLAYBACK_HISTORY_LIMIT),
          );
        });
    },
    [activeBookRef, userId],
  );

  /** A different book is taking the element: its log starts empty. */
  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const clearHistoryNotice = useCallback(() => {
    setHistoryNotice(null);
  }, []);

  useEffect(() => {
    const replayHistory = () => void replayPlaybackHistory(userId).catch(() => undefined);
    if (navigator.onLine) replayHistory();
    window.addEventListener("online", replayHistory);
    return () => {
      window.removeEventListener("online", replayHistory);
    };
  }, [userId]);

  return { history, historyNotice, recordAction, hydrateHistory, clearHistory, clearHistoryNotice };
}
