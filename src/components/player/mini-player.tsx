"use client";

import { Pause, Play, SkipBack, SkipForward } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePlayback } from "./playback-provider";

export function MiniPlayer() {
  const pathname = usePathname();
  const { book, currentTimeMs, isPlaying, toggle, skip, preferences } = usePlayback();
  if (!book || pathname.startsWith("/books/")) return null;
  const percent = Math.min(100, Math.max(0, (currentTimeMs / book.durationMs) * 100));
  const backSeconds = Math.round(preferences.skipBackMs / 1000);
  const forwardSeconds = Math.round(preferences.skipForwardMs / 1000);

  return (
    <aside className="mini-player" aria-label="Now playing">
      <div className="mini-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <Link href={`/books/${book.id}`} className="mini-book">
        <span className="mini-cover">{book.title.slice(0, 2).toUpperCase()}</span>
        <span>
          <strong>{book.title}</strong>
          <small>{book.author}</small>
        </span>
      </Link>
      <div className="mini-controls">
        <button
          type="button"
          onClick={() => skip(-preferences.skipBackMs)}
          aria-label={`Back ${backSeconds} seconds`}
        >
          <SkipBack size={20} weight="fill" />
        </button>
        <button
          type="button"
          className="mini-play"
          onClick={toggle}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={21} weight="fill" /> : <Play size={21} weight="fill" />}
        </button>
        <button
          type="button"
          onClick={() => skip(preferences.skipForwardMs)}
          aria-label={`Forward ${forwardSeconds} seconds`}
        >
          <SkipForward size={20} weight="fill" />
        </button>
      </div>
    </aside>
  );
}
