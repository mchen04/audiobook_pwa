import { ClockCounterClockwise } from "@phosphor-icons/react";

import type { PlaybackHistoryEntry, PlayerChapter } from "@/domain/player";
import { formatClock } from "@/lib/format-time";
import { selectCurrentChapter } from "@/lib/playback-core";

export function HistoryList({
  history,
  chapters,
  onSelect,
}: {
  history: PlaybackHistoryEntry[];
  chapters: PlayerChapter[];
  onSelect: (positionMs: number) => void;
}) {
  if (!history.length) {
    return (
      <div className="history-empty">
        <ClockCounterClockwise size={28} aria-hidden="true" />
        <p>Your playback actions will appear here.</p>
      </div>
    );
  }

  return (
    <ol className="sheet-chapters history-list">
      {history.map((entry, index) => {
        const chapter = selectCurrentChapter(chapters, entry.positionMs);
        const transition =
          entry.previousPositionMs === null
            ? formatClock(entry.positionMs)
            : `${formatClock(entry.previousPositionMs)} → ${formatClock(entry.positionMs)}`;
        return (
          <li key={entry.id}>
            <button type="button" onClick={() => onSelect(entry.positionMs)}>
              <span>{index + 1}</span>
              <span>
                <strong>{historyActionLabel(entry)}</strong>
                <small>
                  {chapter?.title || "Full audiobook"} · {transition} ·{" "}
                  {formatOccurredAt(entry.occurredAt)}
                </small>
              </span>
              <span className="history-rate">{entry.playbackRate}×</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function historyActionLabel(entry: PlaybackHistoryEntry): string {
  const labels: Record<PlaybackHistoryEntry["action"], string> = {
    opened: "Opened audiobook",
    play: "Played",
    pause: "Paused",
    seek: "Moved playback",
    skip_back: "Rewound",
    skip_forward: "Fast-forwarded",
    previous_chapter: "Previous chapter",
    next_chapter: "Next chapter",
    playback_rate: "Changed speed",
    sleep_timer: "Set sleep timer",
    sleep_timer_cleared: "Cleared sleep timer",
    finished: "Marked finished",
    restarted: "Restarted audiobook",
    history_restore: "Restored from history",
  };
  return entry.description
    ? `${labels[entry.action]} · ${entry.description}`
    : labels[entry.action];
}

function formatOccurredAt(value: string): string {
  const occurredAt = new Date(value);
  const today = new Date();
  const sameDay = occurredAt.toDateString() === today.toDateString();
  const sameYear = occurredAt.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay
      ? {}
      : { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }),
    hour: "numeric",
    minute: "2-digit",
  }).format(occurredAt);
}
