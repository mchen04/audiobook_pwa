"use client";

import { ArrowClockwise, ArrowCounterClockwise, Pause, Play } from "@phosphor-icons/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { usePlayback, usePlaybackTime } from "./playback-provider";

export function MiniPlayer() {
  const pathname = usePathname();
  const { book, isPlaying, toggle, skip, preferences } = usePlayback();
  if (!book || pathname.startsWith("/books/")) return null;
  const backSeconds = Math.round(preferences.skipBackMs / 1000);
  const forwardSeconds = Math.round(preferences.skipForwardMs / 1000);

  return (
    <aside className="mini-player" aria-label="Now playing">
      <MiniProgress durationMs={book.durationMs} />
      <Link href={`/books/${book.id}`} className="mini-book">
        <span className="mini-cover">
          {book.coverThumbUrl || book.coverUrl ? (
            <Image
              src={(book.coverThumbUrl || book.coverUrl)!}
              alt=""
              width={50}
              height={50}
              unoptimized
            />
          ) : (
            book.title.slice(0, 2).toUpperCase()
          )}
        </span>
        <span>
          <strong>{book.title}</strong>
          <small>{book.author}</small>
        </span>
      </Link>
      <div className="mini-controls">
        <button
          type="button"
          className="timed-skip"
          onClick={() => skip(-preferences.skipBackMs)}
          aria-label={`Back ${backSeconds} seconds`}
        >
          <ArrowCounterClockwise size={26} />
          <small>{backSeconds}</small>
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
          className="timed-skip"
          onClick={() => skip(preferences.skipForwardMs)}
          aria-label={`Forward ${forwardSeconds} seconds`}
        >
          <ArrowClockwise size={26} />
          <small>{forwardSeconds}</small>
        </button>
      </div>
    </aside>
  );
}

function MiniProgress({ durationMs }: { durationMs: number }) {
  const currentTimeMs = usePlaybackTime();
  const percent = Math.min(100, Math.max(0, (currentTimeMs / durationMs) * 100));
  return (
    <div className="mini-progress" aria-hidden="true">
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}
