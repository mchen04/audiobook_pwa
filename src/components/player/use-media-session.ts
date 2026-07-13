"use client";

import { RefObject, useEffect } from "react";

import type { PlayerBook } from "@/domain/player";
import type { PlayerPreferences } from "@/lib/preferences";

/**
 * System media controls, feature-detected. A missing or partial Media Session
 * implementation never affects playback.
 */
export function useMediaSession(controls: {
  audioRef: RefObject<HTMLAudioElement | null>;
  preferencesRef: RefObject<PlayerPreferences>;
  play: () => void;
  seek: (positionMs: number) => void;
  skip: (deltaMs: number) => void;
}) {
  const { audioRef, preferencesRef, play, seek, skip } = controls;

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", play],
      ["pause", () => audioRef.current?.pause()],
      [
        "seekbackward",
        (details) =>
          skip(
            details.seekOffset ? -details.seekOffset * 1000 : -preferencesRef.current.skipBackMs,
          ),
      ],
      [
        "seekforward",
        (details) =>
          skip(
            details.seekOffset ? details.seekOffset * 1000 : preferencesRef.current.skipForwardMs,
          ),
      ],
      ["seekto", (details) => details.seekTime !== undefined && seek(details.seekTime * 1000)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported actions are optional progressive enhancements.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported action cleanup.
        }
      }
    };
  }, [audioRef, play, preferencesRef, seek, skip]);
}

export function setMediaSessionMetadata(book: PlayerBook): void {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.title,
    artist: book.author,
    album: "Hark",
    artwork: book.coverUrl
      ? [{ src: book.coverUrl }]
      : [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
  });
}

export function setMediaSessionPlaybackState(state: "playing" | "paused"): void {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
}

export function syncMediaSessionPosition(audio: HTMLAudioElement, durationMs: number): void {
  if (!("mediaSession" in navigator)) return;
  try {
    const duration = audio.duration || durationMs / 1000;
    navigator.mediaSession.setPositionState({
      duration: Math.max(duration, 0.001),
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, duration),
    });
  } catch {
    // Some browsers expose Media Session without complete position support.
  }
}
