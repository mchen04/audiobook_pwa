"use client";

import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { PlaybackHistoryEntry, PlaybackHistorySnapshot } from "@/domain/playback-history";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { ACTIVE_USER_KEY, PROGRESS_CONFLICT_EVENT, UNLOAD_PLAYER_EVENT } from "@/lib/app-keys";
import { createListeningTracker, queueListeningSession } from "@/lib/listening-tracker";
import {
  markPausedNow,
  freshestPosition,
  localWinsOver,
  readLocalProgress,
  readMsSinceLastPause,
  resolveStartPosition,
  selectCurrentChapter,
} from "@/lib/playback-core";

import { createTimeStore, type PlaybackTimeStore } from "./playback-time-store";
import { usePreferencesRef } from "./preferences-provider";
import type { ProgressConflictDetail } from "./progress-persister";
import {
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
  syncMediaSessionPosition,
  useMediaSession,
} from "./use-media-session";
import { usePlaybackHistoryLog } from "./use-playback-history-log";
import { useProgressPersistence } from "./use-progress-persistence";
import { type SleepMode, useSleepTimer } from "./use-sleep-timer";
import { useTabArbitration } from "./use-tab-arbitration";
import { safePlay, useTransportActions } from "./use-transport-actions";

type PlaybackContextValue = {
  userId: string;
  book: PlayerBook | null;
  isPlaying: boolean;
  playbackRate: number;
  history: PlaybackHistoryEntry[];
  historyNotice: string | null;
  sleepMode: SleepMode;
  /** Bumped each time a book plays to its end; consumers react to completion. */
  lastEndedAt: number;
  loadBook: (
    book: PlayerBook,
    autoplay?: boolean,
    historySnapshot?: PlaybackHistorySnapshot,
  ) => void;
  toggle: () => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  restoreHistoryPosition: (positionMs: number) => void;
  moveToChapter: (chapter: PlayerChapter, direction: "previous" | "next") => void;
  skip: (deltaMs: number) => void;
  setPlaybackRate: (rate: number) => void;
  setSleepMinutes: (minutes: number) => void;
  setSleepAtChapterEnd: () => void;
  clearSleep: () => void;
  markFinished: () => void;
  restart: () => void;
  unloadBook: () => void;
};

const PlaybackContext = createContext<PlaybackContextValue | null>(null);
const PlaybackTimeContext = createContext<PlaybackTimeStore | null>(null);

export function PlaybackProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeBookRef = useRef<PlayerBook | null>(null);
  const trackerRef = useRef(createListeningTracker(queueListeningSession(userId)));
  const suppressNextPauseRef = useRef(false);
  const positionSyncKeyRef = useRef("");
  const timeStore = useMemo(() => createTimeStore(), []);
  const [book, setBook] = useState<PlayerBook | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setRateState] = useState(1);
  const [lastEndedAt, setLastEndedAt] = useState(0);

  // Read-at-call-time: preferences must not re-render the transport, so the
  // provider never subscribes to them. `PreferencesProvider` owns the state.
  const preferencesRef = usePreferencesRef();
  const announcePlaying = useTabArbitration(audioRef);
  const {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
    reconcileCompletion,
  } = useProgressPersistence(userId, audioRef, activeBookRef);
  const { history, historyNotice, recordAction, hydrateHistory, clearHistory, clearHistoryNotice } =
    usePlaybackHistoryLog(userId, audioRef, activeBookRef);
  const {
    sleepMode,
    setSleepMinutes: setSleepMinutesTarget,
    setSleepAtChapterEnd: setSleepAtChapterEndTarget,
    clearSleep: clearSleepTarget,
    onTimeUpdate: onSleepTick,
  } = useSleepTimer(audioRef);

  useEffect(() => {
    activeBookRef.current = book;
  }, [book]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_USER_KEY, userId);
  }, [userId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const updateTime = () => {
      const positionMs = audio.currentTime * 1000;
      timeStore.write(positionMs);
      // Programmatic seeks also fire timeupdate; only actual listening may
      // persist, otherwise merely opening a book would overwrite the position.
      if (!audio.paused) onListeningTick(positionMs);
      if (activeBookRef.current) {
        onSleepTick(audio);
        syncMediaSessionPosition(audio, activeBookRef.current.durationMs, positionSyncKeyRef);
      }
    };
    const markPlaying = () => {
      markInProgress();
      setIsPlaying(true);
      trackerRef.current.begin(audio.currentTime * 1000);
      announcePlaying();
      setMediaSessionPlaybackState("playing");
      recordAction("play");
    };
    const markPaused = () => {
      setIsPlaying(false);
      setMediaSessionPlaybackState("paused");
      if (suppressNextPauseRef.current) {
        suppressNextPauseRef.current = false;
        return;
      }
      const positionMs = audio.currentTime * 1000;
      // The marker records an absence from a specific book, so there is nothing
      // to mark when no book is loaded.
      if (activeBookRef.current) {
        markPausedNow(userId, activeBookRef.current.id);
        trackerRef.current.end(activeBookRef.current.id, positionMs);
      }
      void persistProgress("pause", positionMs);
      recordAction("pause", positionMs);
    };
    const markEnded = () => {
      setIsPlaying(false);
      const endPositionMs = activeBookRef.current?.durationMs || audio.currentTime * 1000;
      if (activeBookRef.current) trackerRef.current.end(activeBookRef.current.id, endPositionMs);
      markPositionChanged();
      void persistProgress("ended", endPositionMs, true);
      recordAction("finished", endPositionMs);
      setLastEndedAt(Date.now());
    };

    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("play", markPlaying);
    audio.addEventListener("pause", markPaused);
    audio.addEventListener("ended", markEnded);
    return () => {
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("play", markPlaying);
      audio.removeEventListener("pause", markPaused);
      audio.removeEventListener("ended", markEnded);
    };
  }, [
    announcePlaying,
    markInProgress,
    markPositionChanged,
    onListeningTick,
    onSleepTick,
    persistProgress,
    recordAction,
    timeStore,
    userId,
  ]);

  const { actions: transport, cancelSeekPersist } = useTransportActions({
    audioRef,
    activeBookRef,
    suppressNextPauseRef,
    timeStore,
    persistProgress,
    saveDurableState,
    markPositionChanged,
    recordAction,
  });

  // Every dependency here is referentially stable, so the actions object is
  // created once; consumers can put it (or any method) in effect deps safely.
  const actions = useMemo(() => {
    return {
      loadBook(nextBook: PlayerBook, autoplay = false, historySnapshot?: PlaybackHistorySnapshot) {
        const audio = audioRef.current;
        if (!audio) return;
        if (activeBookRef.current?.id !== nextBook.id) {
          const previousBook = activeBookRef.current;
          if (previousBook) {
            // The previous book's position is made durable BEFORE the seek
            // debounce is dropped, because dropping it is what used to throw
            // away a seek the user made while paused.
            const previousPositionMs = audio.currentTime * 1000;
            if (!audio.paused) suppressNextPauseRef.current = true;
            // `completed` is deliberately NOT passed. A literal `false` here
            // un-finished the book the user had just finished — locally and on
            // the server — and it fired by itself on the autoplay-next path,
            // where the finished book is ALWAYS the previous one. Left
            // undefined, both writes fall through to the completion this book
            // actually has (`completionRef`, then `previousBook.completed`), so
            // switching books records where the user was without ever making a
            // claim about whether they finished it.
            saveDurableState("book-switch", previousPositionMs, undefined, previousBook);
            void persistProgress("book-switch", previousPositionMs, undefined, previousBook);
            cancelSeekPersist();
            if (!audio.paused) audio.pause();
            trackerRef.current.end(previousBook.id, previousPositionMs);
          } else {
            cancelSeekPersist();
          }
          trackerRef.current.reset();

          const localProgress = readLocalProgress(userId, nextBook.id);
          const localIsFresher = localWinsOver(localProgress, nextBook.initialProgressOccurredAt);
          const { startAtMs, appliedRewindMs } = resolveStartPosition({
            storedPositionMs: freshestPosition({
              local: localProgress,
              serverPositionMs: nextBook.initialPositionMs,
              serverOccurredAt: nextBook.initialProgressOccurredAt,
            }),
            durationMs: nextBook.durationMs,
            smartRewindEnabled: preferencesRef.current.smartRewind,
            msSinceLastPause: readMsSinceLastPause(userId, nextBook.id),
          });
          // The rewind is a one-shot listening aid: refresh the pause marker so
          // reopening the book again does not walk the position further back.
          if (appliedRewindMs > 0) markPausedNow(userId, nextBook.id);
          // The rate is part of where the user left off. A relaunch with no
          // network reads the book's server-side rate from whatever the mirror
          // last held, which is 1.0 for a book whose 1.6x was only ever set on
          // this device — so this device's own record wins whenever it also
          // owns the position.
          const startRate =
            localIsFresher && localProgress?.playbackRate
              ? localProgress.playbackRate
              : nextBook.initialPlaybackRate;

          audio.src = nextBook.mediaUrl;
          audio.currentTime = startAtMs / 1000;
          audio.playbackRate = startRate;
          activeBookRef.current = nextBook;
          // Nothing has happened to this book's position yet on this open, so a
          // close with no listening must not write the (possibly rewound)
          // start back as if the user had chosen it.
          resetPositionChanged();
          setBook(nextBook);
          clearHistory();
          timeStore.write(startAtMs);
          setRateState(startRate);
          setMediaSessionMetadata(nextBook);
          recordAction(
            "opened",
            startAtMs,
            null,
            appliedRewindMs > 0
              ? `Smart rewind ${Math.round(appliedRewindMs / 1000)} seconds`
              : null,
          );
        }
        hydrateHistory(nextBook.id, historySnapshot);
        if (autoplay) safePlay(audio);
      },
      setPlaybackRate(rate: number) {
        const bounded = Math.min(3, Math.max(0.5, rate));
        if (audioRef.current) audioRef.current.playbackRate = bounded;
        setRateState(bounded);
        // The rate is part of durable playback state, so it survives reloads
        // even when changed while paused.
        markPositionChanged();
        void persistProgress("rate-change", (audioRef.current?.currentTime || 0) * 1000);
        recordAction("playback_rate", undefined, null, `${bounded}×`);
      },
      setSleepMinutes(minutes: number) {
        setSleepMinutesTarget(minutes);
        recordAction("sleep_timer", undefined, null, `${minutes} minutes`);
      },
      setSleepAtChapterEnd() {
        const activeBook = activeBookRef.current;
        const audio = audioRef.current;
        if (activeBook && audio) {
          setSleepAtChapterEndTarget(audio.currentTime * 1000, activeBook.chapters);
          recordAction("sleep_timer", undefined, null, "End of chapter");
        }
      },
      clearSleep() {
        clearSleepTarget();
        recordAction("sleep_timer_cleared");
      },
      unloadBook() {
        const audio = audioRef.current;
        // Durable BEFORE anything is torn down. `cancelSeekPersist` used to run
        // first and `audio.pause()` on an already-paused element fires no
        // event, so leaving the player after a seek made while paused lost the
        // seek entirely — and `removeAttribute("src")` then zeroes
        // `currentTime`, so there is nothing left to read afterwards either.
        if (audio && activeBookRef.current) {
          const positionMs = audio.currentTime * 1000;
          saveDurableState("book-unload", positionMs);
          void persistProgress("book-unload", positionMs);
        }
        cancelSeekPersist();
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        resetPositionChanged();
        activeBookRef.current = null;
        setBook(null);
        clearHistory();
        clearHistoryNotice();
        timeStore.write(0);
        setIsPlaying(false);
      },
    };
  }, [
    cancelSeekPersist,
    clearHistory,
    clearHistoryNotice,
    clearSleepTarget,
    hydrateHistory,
    markPositionChanged,
    persistProgress,
    preferencesRef,
    recordAction,
    resetPositionChanged,
    saveDurableState,
    setSleepAtChapterEndTarget,
    setSleepMinutesTarget,
    timeStore,
    userId,
  ]);

  useEffect(() => {
    window.addEventListener(UNLOAD_PLAYER_EVENT, actions.unloadBook);
    return () => window.removeEventListener(UNLOAD_PLAYER_EVENT, actions.unloadBook);
  }, [actions]);

  useEffect(() => {
    // The ONE listener for a conflict another device won. Completion
    // bookkeeping is brought in step FIRST, then the playback surface
    // (element, stores) — the order is load-bearing and owned here.
    const reconcile = (event: Event) => {
      const detail = (event as CustomEvent<ProgressConflictDetail>).detail;
      if (detail.userId !== userId || activeBookRef.current?.id !== detail.bookId) return;
      reconcileCompletion(detail);
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = detail.positionMs / 1000;
        audio.playbackRate = detail.playbackRate;
      }
      timeStore.write(detail.positionMs);
      setRateState(detail.playbackRate);
    };
    window.addEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
    return () => window.removeEventListener(PROGRESS_CONFLICT_EVENT, reconcile);
  }, [reconcileCompletion, timeStore, userId]);

  useMediaSession({
    audioRef,
    preferencesRef,
    play: transport.play,
    seek: transport.seek,
    skip: transport.skip,
  });

  const value = useMemo<PlaybackContextValue>(
    () => ({
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      lastEndedAt,
      ...transport,
      ...actions,
    }),
    [
      userId,
      book,
      isPlaying,
      playbackRate,
      history,
      historyNotice,
      sleepMode,
      lastEndedAt,
      transport,
      actions,
    ],
  );

  return (
    <PlaybackContext.Provider value={value}>
      <PlaybackTimeContext.Provider value={timeStore}>
        {children}
        <audio ref={audioRef} preload="metadata" className="visually-hidden" />
      </PlaybackTimeContext.Provider>
    </PlaybackContext.Provider>
  );
}

export function usePlayback() {
  const context = useContext(PlaybackContext);
  if (!context) throw new Error("usePlayback must be used inside PlaybackProvider");
  return context;
}

/** Current position in ms; re-renders the subscriber on every timeupdate. */
export function usePlaybackTime(): number {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTime must be used inside PlaybackProvider");
  return useSyncExternalStore(store.subscribe, store.read, readServerTime);
}

/**
 * Recomputes `derive` on every playback tick but re-renders the subscriber
 * only when the derived value changes. Constrained to primitives so a fresh
 * object per call can never trip React's snapshot-caching check.
 */
export function usePlaybackDerived<T extends string | number | boolean | null>(derive: () => T): T {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackDerived must be used inside PlaybackProvider");
  return useSyncExternalStore(store.subscribe, derive, derive);
}

/**
 * Derives a primitive from the current position; recomputed per tick but the
 * subscriber re-renders only when the derived value changes. This is what the
 * read-along view leans on: cue lookups run every tick, re-renders only on
 * cue boundaries.
 */
export function usePlaybackTimeDerived<T extends string | number | boolean | null>(
  derive: (timeMs: number) => T,
): T {
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("usePlaybackTimeDerived must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => derive(store.read()),
    () => derive(0),
  );
}

/** The chapter under the playhead; re-renders only when the chapter changes. */
export function useCurrentChapter(): PlayerChapter | null {
  const { book } = usePlayback();
  const store = useContext(PlaybackTimeContext);
  if (!store) throw new Error("useCurrentChapter must be used inside PlaybackProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => (book ? selectCurrentChapter(book.chapters, store.read()) : null),
    readServerChapter,
  );
}

const readServerTime = () => 0;
const readServerChapter = () => null;
