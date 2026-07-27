import type { PlayerChapter } from "@/domain/player";

/** How close to a boundary counts as "at" it, in milliseconds. */
export const CHAPTER_END_EPSILON_MS = 350;
export const BOOK_END_EPSILON_MS = 1_000;

/**
 * The chapter containing a position. Positions at or past the last chapter's
 * start (including the sliver between its endMs and the audio's true duration)
 * belong to the final chapter so chapter navigation keeps working at the end.
 */
export function selectCurrentChapter(
  chapters: PlayerChapter[],
  currentTimeMs: number,
): PlayerChapter | null {
  const last = chapters[chapters.length - 1];
  if (!last) return null;
  if (currentTimeMs >= last.startMs) return last;
  // Chapters are sorted and non-overlapping, so binary-search the last one
  // starting at or before the position — this runs per timeupdate tick and
  // books can carry 10k+ chapters.
  let low = 0;
  let high = chapters.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid]!.startMs <= currentTimeMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const chapter = chapters[candidate]!;
  return currentTimeMs < chapter.endMs ? chapter : null;
}

/** Bounded smart-rewind for time spent away from the book. */
export function rewindForAbsence(absenceMs: number): number {
  if (!Number.isFinite(absenceMs) || absenceMs < 60_000) return 0;
  if (absenceMs < 10 * 60_000) return 5_000;
  if (absenceMs < 60 * 60_000) return 15_000;
  return 30_000;
}

/**
 * Where playback should begin for a stored position. A book stored at its very
 * end restarts from the beginning; otherwise smart rewind (when enabled and a
 * pause marker exists) backs up a bounded amount.
 */
export function resolveStartPosition(input: {
  storedPositionMs: number;
  durationMs: number;
  smartRewindEnabled: boolean;
  msSinceLastPause: number | null;
}): { startAtMs: number; appliedRewindMs: number } {
  if (input.storedPositionMs >= input.durationMs - BOOK_END_EPSILON_MS) {
    return { startAtMs: 0, appliedRewindMs: 0 };
  }
  const appliedRewindMs =
    input.smartRewindEnabled && input.msSinceLastPause !== null
      ? rewindForAbsence(input.msSinceLastPause)
      : 0;
  return { startAtMs: Math.max(0, input.storedPositionMs - appliedRewindMs), appliedRewindMs };
}

export function isChapterEnding(chapter: PlayerChapter, positionMs: number): boolean {
  return chapter.endMs - positionMs <= CHAPTER_END_EPSILON_MS;
}

/* Per-user local playback state. Keys are user-scoped so account switches on
 * one device never leak positions between accounts. */

/**
 * WHICH MECHANISM performed a durable write — not which function called it.
 *
 * This exists to settle one question that no instrument on a development
 * machine can answer (`docs/resume-durability-device-check.md`): while a PWA is
 * backgrounded with the screen off and audio playing, does iOS suspend BOTH the
 * 200 ms rescheduling timer AND the media element's `timeupdate`? Each writer
 * alone is measured to bound the loss; only their simultaneous suspension loses
 * ground, and the automated suite cannot observe it because Playwright's WebKit
 * never reports a page as genuinely hidden.
 *
 * The answer is legible from the record itself once the record says who wrote
 * it. After a backgrounded listen, `"visibility-flush"` with a stale `writtenAt`
 * means both writers were frozen for the whole session; `"media-tick"` or
 * `"cadence-timer"` with a recent one means that writer survived.
 *
 * So these are named for the PLATFORM MECHANISM that produced the write —
 * `"media-tick"` is the media pipeline, `"cadence-timer"` is `setTimeout` — and
 * not for the hook or handler the call sits in, because it is the mechanism's
 * survival that is in question.
 */
const PLAYBACK_WRITE_SOURCES = [
  /** The media pipeline's `timeupdate`. Survives iOS suspending timers. */
  "media-tick",
  /** The 200 ms self-rescheduling `setTimeout`. Suspended by a backgrounded page. */
  "cadence-timer",
  /** The synchronous flush on `visibilitychange` to hidden. */
  "visibility-flush",
  /** The synchronous flush on `pagehide`, which is terminal at any visibility. */
  "pagehide-flush",
  "pause",
  "seek",
  "ended",
  "rate-change",
  /** Leaving one book for another; the write belongs to the book being left. */
  "book-switch",
  "book-unload",
] as const;

export type PlaybackWriteSource = (typeof PLAYBACK_WRITE_SOURCES)[number];

export type LocalPosition = {
  positionMs: number;
  occurredAt: number;
  /** Absent on records written before the rate and completion were durable. */
  playbackRate?: number;
  completed?: boolean;
  /**
   * Which mechanism wrote this record. Absent on records written before writes
   * carried their provenance.
   */
  source?: PlaybackWriteSource;
  /**
   * WHEN THE WRITE HAPPENED — deliberately NOT `occurredAt`.
   *
   * `occurredAt` means "when this position was reached" and is preserved across
   * a re-write that carries no new position, because it is the only thing
   * `localWinsOver` compares and re-stamping it lets a stale tab overrule
   * another device's real listening. `writtenAt` has the opposite job: it is
   * always the real moment of the write, so a record whose position has not
   * moved for five minutes still shows that something wrote it five minutes ago
   * — or that nothing did. Conflating the two would reintroduce the cross-device
   * regression `momentThisPositionWasReached` exists to prevent.
   *
   * Absent on records written before writes carried their provenance.
   */
  writtenAt?: number;
  /**
   * WAS THE AUDIO ACTUALLY PLAYING at the instant of this write?
   *
   * The one fact a durable record could not previously answer, and the one
   * `detectSuspendedSession` cannot do without. Everything else it needs is
   * already here: `positionMs` is where the user was, `writtenAt` is when, and
   * `playbackRate` is how fast the book was moving. What none of those say is
   * whether there was a listening session still running at that moment — and a
   * hide-edge write happens on EVERY backgrounding, paused or playing. A paused
   * one has no lost stretch behind it and must never produce an offer.
   *
   * Written only when true, so absent means "not playing, or a build that
   * predates this field" — both of which are correctly read as "do not offer".
   */
  playingAtWrite?: boolean;
};

/**
 * The whole durable playback tuple for one book, written SYNCHRONOUSLY.
 *
 * This is the only write in the app that a terminating page is guaranteed to
 * complete. It runs to the `setItem` with no await, no lock and no IndexedDB
 * transaction in front of it, because a `visibilitychange` or `pagehide`
 * handler on iOS gets one task and then the process may be gone: anything
 * scheduled behind `navigator.locks.request` (an asynchronous grant, not a
 * microtask) or behind an IDB transaction simply never runs.
 *
 * The rate and the completion flag travel with the position because the user's
 * request was "save the proper and necessary info": a relaunch that restores
 * the second but resets 1.6x to 1.0x has still lost their place.
 *
 * A throwing `setItem` — Safari's "Block All Cookies", a full quota — must not
 * take anything else down with it. It is contained here so the caller can go on
 * to journal the same event in the outbox, which is the other durable copy.
 */
export function saveLocalPlaybackState(
  userId: string,
  bookId: string,
  state: {
    positionMs: number;
    playbackRate?: number;
    completed?: boolean;
    occurredAt?: number;
    source?: PlaybackWriteSource;
    /** Was the media element playing at the instant of this write? */
    playing?: boolean;
  },
): boolean {
  const positionMs = Math.round(state.positionMs);
  const record: LocalPosition = {
    positionMs,
    occurredAt: state.occurredAt ?? momentThisPositionWasReached(userId, bookId, positionMs),
    // Always the real moment of THIS write, whatever `occurredAt` resolved to.
    writtenAt: Date.now(),
  };
  if (typeof state.playbackRate === "number" && Number.isFinite(state.playbackRate)) {
    record.playbackRate = state.playbackRate;
  }
  if (typeof state.completed === "boolean") record.completed = state.completed;
  if (state.source) record.source = state.source;
  if (state.playing === true) record.playingAtWrite = true;
  try {
    localStorage.setItem(localPositionKey(userId, bookId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * When did this device reach this position? Not: when did it last say so.
 *
 * `occurredAt` is the only thing `localWinsOver` compares, so it is a CLAIM
 * ABOUT LISTENING, not a write timestamp — and a write that carries no new
 * position has no new listening to claim. Re-stamping one is how a device
 * silently overrules another device that really did move the book forward.
 *
 * The path that proved it (`tests/resume/uncovered-axes.spec.ts` X3, measured in
 * WebKit): device A is paused at 6793 ms and its tab is left open; device B
 * takes the book to 15666 ms; A's tab is then navigated away from. `pagehide` is
 * terminal at any visibility so it flushes unconditionally — correctly, it is
 * the last task a killed iOS page gets — and the flush rewrote A's own record as
 * the SAME 6793 ms with an `occurredAt` 15.4 s newer. Nothing about the user's
 * position changed; only the clock did. `localWinsOver` then read that fresher
 * stamp, preferred it over the server's newer cross-device value, and A came
 * back 8873 ms behind, throwing away listening the user had really done, with no
 * user input anywhere in the sequence.
 *
 * Keeping the earlier moment fixes it at the source and leaves the flush alone,
 * which matters: the same unconditional flush is what saves the position in the
 * single-device crash cases, and removing it to fix this would trade one lost
 * position for another. A write that moves the position by even a millisecond
 * still stamps `Date.now()`, because then there IS new listening to claim.
 *
 * A caller that passes `occurredAt` explicitly is stating the moment itself and
 * is left alone. A stored record with `occurredAt: 0` (every pre-v2 value)
 * claims no moment at all, so it cannot lend one.
 */
function momentThisPositionWasReached(userId: string, bookId: string, positionMs: number): number {
  const previous = readLocalProgress(userId, bookId);
  return previous && previous.positionMs === positionMs && previous.occurredAt > 0
    ? previous.occurredAt
    : Date.now();
}

export function saveLocalPosition(
  userId: string,
  bookId: string,
  positionMs: number,
  occurredAt = Date.now(),
): void {
  saveLocalPlaybackState(userId, bookId, { positionMs, occurredAt });
}

/**
 * Forget everything this device remembers about where the user was in a book.
 *
 * Deleting a book has to take the position with it, and it did not. The delete
 * flow dispatches `UNLOAD_PLAYER_EVENT`, and `unloadBook` writes the position
 * one last time on the way out — so a delete ENDED by recording a fresh
 * `chapterline:position:*` record for the book it had just destroyed, stamped
 * later than anything in the mirror.
 *
 * `healMirrorPlaybackFromLocal` then sweeps exactly those keys on every launch
 * and writes back any whose moment beats the mirror's. The delete removed the
 * book aggregate from IndexedDB; the next launch put a playback row for it
 * straight back, and the launch after that did it again, because nothing ever
 * removed the localStorage record that was feeding it. One orphan row per
 * deleted book, forever, on a store the shelf reads.
 *
 * The pause marker goes with it. It is the same book's state, it is what smart
 * rewind reads, and a re-import of the same file is matched to the same book id
 * by fingerprint — so a stale marker would hand a freshly imported book a
 * rewind earned by a copy the user deleted months ago. The dismissed-suspension
 * marker goes for the same reason: it is an answer about one deleted book's
 * unrecorded stretch, and the fingerprint match would hand it to the re-import.
 */
export function clearLocalPlaybackState(userId: string, bookId: string): void {
  try {
    localStorage.removeItem(localPositionKey(userId, bookId));
    localStorage.removeItem(lastPausedKey(userId, bookId));
    localStorage.removeItem(suspensionDismissedKey(userId, bookId));
  } catch {
    // A device with storage blocked has nothing stored to remove.
  }
}

export function readLocalPosition(userId: string, bookId: string): number | null {
  return readLocalProgress(userId, bookId)?.positionMs ?? null;
}

export function readLocalProgress(userId: string, bookId: string): LocalPosition | null {
  // `getItem` is inside the try, not in front of it: it throws outright when
  // the user has blocked storage, and a throw from here used to propagate
  // through `loadBook` so the book never opened at all.
  try {
    const value = localStorage.getItem(localPositionKey(userId, bookId));
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "number") return validLocalPosition(parsed, 0);
      if (parsed && typeof parsed === "object") return validLocalPosition(parsed, undefined);
    } catch {
      return validLocalPosition(Number(value), 0);
    }
    return null;
  } catch {
    return null;
  }
}

/** Every book this device holds a local position for, for the shelf projection. */
export function listLocalPlaybackStates(
  userId: string,
): Array<{ bookId: string; state: LocalPosition }> {
  const prefix = `chapterline:position:${userId}:`;
  const found: Array<{ bookId: string; state: LocalPosition }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const bookId = key.slice(prefix.length);
      const state = readLocalProgress(userId, bookId);
      if (state) found.push({ bookId, state });
    }
  } catch {
    return found;
  }
  return found;
}

/**
 * The book this device wrote a position for most recently — for the settings
 * diagnostics readout, which reports the provenance of the latest durable write.
 *
 * Ordered by `writtenAt`, not `occurredAt`: the question this answers is "what
 * wrote last", and `occurredAt` is deliberately frozen across re-writes that
 * carry no new position, so ordering by it would show the wrong book. A record
 * from before provenance existed has no `writtenAt` and so sorts oldest, which
 * is the honest answer — nothing is known about when it was written.
 */
export function readLatestLocalPlayback(
  userId: string,
): { bookId: string; state: LocalPosition } | null {
  let latest: { bookId: string; state: LocalPosition } | null = null;
  for (const entry of listLocalPlaybackStates(userId)) {
    if (!latest || (entry.state.writtenAt ?? 0) > (latest.state.writtenAt ?? 0)) latest = entry;
  }
  return latest;
}

/* ------------------------------------------------------------------ *
 * Recovering a listening session the device could not record
 * ------------------------------------------------------------------ */

/**
 * The write occasions that mean "the app was going away".
 *
 * Only these two can leave the signature below, and that is the whole trick:
 * there is ONE durable record per (user, book) and every write overwrites it,
 * so a record still saying `visibility-flush` or `pagehide-flush` is proof that
 * NOTHING wrote after the hide edge. No extra bookkeeping, no second key, and
 * nothing for a later write to forget to clear — the absence of a later write
 * is the absence of a later write.
 */
const HIDE_EDGE_SOURCES: readonly PlaybackWriteSource[] = ["visibility-flush", "pagehide-flush"];

/**
 * How much unrecorded listening is worth telling the user about.
 *
 * The cadence writes every 200 ms, so anything the normal writers covered is
 * off by a fifth of a second and would never reach a record that still names
 * the hide edge in the first place. This floor is the second, independent
 * guard: 60 s is three hundred cadence intervals, and it is stated on the
 * PROJECTED ADVANCE rather than on the elapsed wall clock so that the same
 * number means the same thing at 0.5x and at 3x, and so that a projection the
 * duration clamp has flattened cannot be offered as a jump to nowhere.
 *
 * BEING STATED ON THE ADVANCE IS ALSO WHAT COVERS THE END OF THE BOOK, and
 * there is deliberately no second check for it. A book parked within
 * `BOOK_END_EPSILON_MS` of its end restarts from zero on the next open
 * (`resolveStartPosition`), so a projection from its stored position describes
 * a place the player is not going to be — but the clamp already leaves at most
 * `BOOK_END_EPSILON_MS` of advance there, and this floor is sixty times that,
 * so the offer is withdrawn by arithmetic. An explicit end-of-book branch was
 * written first and then removed: no test could make it fail, which is the
 * definition of a line that is not doing anything.
 *
 * It is deliberately coarse. A recovery prompt is an interruption, and one that
 * appears after an ordinary thirty-second glance at another app is a bug the
 * user meets several times a day. Erring long costs a user who really did lose
 * fifty seconds nothing they cannot fix by scrubbing.
 */
export const SUSPENSION_GAP_FLOOR_MS = 60_000;

/**
 * A stretch of listening the device could not record, and where it MIGHT have
 * reached. Every field is evidence; `projectedPositionMs` alone is a guess.
 */
export type SuspendedSession = {
  /**
   * The position the hide-edge write recorded. THIS REMAINS THE SOURCE OF
   * TRUTH: the app resumes here, and nothing in this module may move it.
   */
  recordedPositionMs: number;
  /** Wall clock of the hide-edge write. Identifies this gap for dismissal. */
  writtenAt: number;
  /** How long the device went without recording anything. */
  elapsedMs: number;
  /** The rate the book was playing at when the app went away. */
  playbackRate: number;
  /**
   * Where playback WOULD have reached if it ran for the whole gap at that rate,
   * clamped to the book. An estimate, and must be labelled as one wherever it
   * is shown — if iOS stopped the audio early, this is simply wrong, which is
   * exactly why it is offered and never applied.
   */
  projectedPositionMs: number;
};

/**
 * Did this device stop being able to record a session that was still playing?
 *
 * THE SIGNATURE. The last durable write was made at the hide edge, it says
 * audio was live at that moment, and the wall clock has since moved far enough
 * that the cadence cannot account for it. On a phone that means: the app was
 * backgrounded with the book playing, iOS suspended both the 200 ms timer and
 * the media element's `timeupdate` — the one question this repo cannot answer
 * on a development machine, see `docs/resume-durability-device-check.md` — and
 * the process was then reaped with no further callback. The measured cost of
 * that case is the entire session: `tests/resume`'s both-writers-dead row loses
 * 9644 ms out of 9500 ms of listening, scaling linearly.
 *
 * WHAT THIS IS NOT. It is not a claim that iOS does suspend both writers, and
 * it does not need one. If either writer survives a real backgrounding the last
 * record names that writer, the predicate returns null, and the user never sees
 * anything. The cost in the good case is one `localStorage` read at launch.
 *
 * WHAT IT MUST NEVER DO is move anybody. The returned position is a PROPOSAL
 * for a control the user has to press. Resuming forward on the strength of an
 * extrapolation would skip content the user never heard — the worst failure
 * this player has, and a blocker here at any magnitude — and it would be
 * straightforwardly wrong in the case where iOS stopped the audio too.
 *
 * The bounds, all of them refusals rather than adjustments:
 *
 *   - a record that names any other writer is a record something wrote after
 *     the hide edge, so there is no unrecorded stretch;
 *   - a hide edge taken while PAUSED has nothing behind it to recover;
 *   - a finished book has no unheard stretch behind it;
 *   - a missing or nonsensical rate falls back to 1x rather than scaling the
 *     estimate by a number nobody wrote;
 *   - the projection is clamped to the book, and the offer is withdrawn when
 *     what survives the clamp is under the floor.
 */
export function detectSuspendedSession(input: {
  record: LocalPosition | null;
  durationMs: number;
  /** Injected so the maths is testable; defaults to the wall clock. */
  now?: number;
}): SuspendedSession | null {
  const { record, durationMs } = input;
  if (!record || record.playingAtWrite !== true || record.completed === true) return null;
  if (!record.source || !HIDE_EDGE_SOURCES.includes(record.source)) return null;
  const writtenAt = record.writtenAt;
  if (typeof writtenAt !== "number" || !Number.isFinite(writtenAt) || writtenAt <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const elapsedMs = (input.now ?? Date.now()) - writtenAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const rate =
    typeof record.playbackRate === "number" &&
    Number.isFinite(record.playbackRate) &&
    record.playbackRate > 0
      ? record.playbackRate
      : 1;
  const projectedPositionMs = Math.min(record.positionMs + elapsedMs * rate, durationMs);
  if (projectedPositionMs - record.positionMs < SUSPENSION_GAP_FLOOR_MS) return null;
  return {
    recordedPositionMs: record.positionMs,
    writtenAt,
    elapsedMs,
    playbackRate: rate,
    projectedPositionMs,
  };
}

/**
 * The gap this device has already been told to stop asking about.
 *
 * Keyed by the hide-edge write's own `writtenAt`, which is what makes "the same
 * gap" a decidable question: a dismissal is a statement about one specific
 * unrecorded stretch, not a permanent opt-out. A LATER suspension writes a
 * later `writtenAt` and is offered again, which is right — it is a different
 * loss, and the user's last answer said nothing about it.
 */
export function readDismissedSuspensionGap(userId: string, bookId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(suspensionDismissedKey(userId, bookId)) || 0);
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function dismissSuspensionGap(userId: string, bookId: string, writtenAt: number): void {
  try {
    localStorage.setItem(suspensionDismissedKey(userId, bookId), String(writtenAt));
  } catch {
    // Storage is blocked. The offer reappears next launch, which is a nuisance
    // and not a lost position; nothing else in the player may fail for it.
  }
}

function suspensionDismissedKey(userId: string, bookId: string): string {
  return `chapterline:suspension-dismissed:${userId}:${bookId}`;
}

/**
 * Does this device's own record describe a later moment than the server's?
 *
 * A local record with no timestamp (`occurredAt: 0`, which is every pre-v2
 * value) loses to any server timestamp: it claims no moment at all, so it
 * cannot claim a later one.
 */
export function localWinsOver(
  local: LocalPosition | null,
  serverOccurredAt: string | null,
): boolean {
  if (!local) return false;
  if (!serverOccurredAt) return true;
  const serverTime = Date.parse(serverOccurredAt);
  return !(Number.isFinite(serverTime) && serverTime > local.occurredAt);
}

export function freshestPosition(input: {
  local: LocalPosition | null;
  serverPositionMs: number;
  serverOccurredAt: string | null;
}): number {
  const { local } = input;
  return local && localWinsOver(local, input.serverOccurredAt)
    ? local.positionMs
    : input.serverPositionMs;
}

/**
 * How long the user has been away from THIS book, for smart rewind.
 *
 * Scoped by user and book. A single global marker made the absence a property
 * of the device rather than of the book: pausing book A and returning to book B
 * a week later rewound B by 30 seconds even though B had never been paused at
 * all, and switching accounts on one device leaked the other account's absence.
 * Smart rewind is "remind me where I was in THIS story", so the marker has to
 * be per story, per account.
 *
 * An absent marker returns null (never 0), which `resolveStartPosition` treats
 * as "no rewind" rather than "no absence" — a book that has never been paused
 * must not be rewound.
 */
export function readMsSinceLastPause(userId: string, bookId: string): number | null {
  try {
    const raw = Number(localStorage.getItem(lastPausedKey(userId, bookId)) || 0);
    return raw > 0 ? Date.now() - raw : null;
  } catch {
    return null;
  }
}

export function markPausedNow(userId: string, bookId: string): void {
  try {
    localStorage.setItem(lastPausedKey(userId, bookId), String(Date.now()));
  } catch {
    // A device with storage blocked still has to be able to play.
  }
}

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem("chapterline:device-id");
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem("chapterline:device-id", created);
    return created;
  } catch {
    return sessionDeviceId();
  }
}

function lastPausedKey(userId: string, bookId: string): string {
  return `chapterline:last-paused-at:${userId}:${bookId}`;
}

/**
 * One stable id for a session that cannot persist one. Minting a fresh uuid per
 * call would give every write its own device identity, and the server orders
 * progress per (user, book, device) — a new device on every write is no
 * ordering at all, and every write but the first would be discarded.
 */
let ephemeralDeviceId: string | null = null;

function sessionDeviceId(): string {
  if (!ephemeralDeviceId) ephemeralDeviceId = `ephemeral:${crypto.randomUUID()}`;
  return ephemeralDeviceId;
}

function localPositionKey(userId: string, bookId: string): string {
  return `chapterline:position:${userId}:${bookId}`;
}

function validLocalPosition(parsed: unknown, occurredAtOverride: number | undefined) {
  const entry = (
    typeof parsed === "number" ? { positionMs: parsed } : parsed
  ) as Partial<LocalPosition> | null;
  const positionMs = entry?.positionMs;
  if (typeof positionMs !== "number" || !Number.isFinite(positionMs) || positionMs < 0) return null;
  const occurredAt = occurredAtOverride ?? entry?.occurredAt;
  const record: LocalPosition = {
    positionMs,
    occurredAt:
      typeof occurredAt === "number" && Number.isFinite(occurredAt) && occurredAt >= 0
        ? occurredAt
        : 0,
  };
  if (typeof entry?.playbackRate === "number" && Number.isFinite(entry.playbackRate)) {
    record.playbackRate = entry.playbackRate;
  }
  if (typeof entry?.completed === "boolean") record.completed = entry.completed;
  // Provenance is diagnostic and is rendered verbatim, so only a value this
  // build actually writes is carried through; anything else stays absent rather
  // than putting an unknown string in front of the user.
  if (isWriteSource(entry?.source)) record.source = entry.source;
  const writtenAt = entry?.writtenAt;
  if (typeof writtenAt === "number" && Number.isFinite(writtenAt) && writtenAt >= 0) {
    record.writtenAt = writtenAt;
  }
  // Only a literal `true` carries through. Anything else — a string, a 1, a
  // field a future build repurposes — is not evidence that a listening session
  // was running, and `detectSuspendedSession` must never offer to move the
  // user's position on the strength of a value it had to coerce.
  if (entry?.playingAtWrite === true) record.playingAtWrite = true;
  return record;
}

function isWriteSource(value: unknown): value is PlaybackWriteSource {
  return (PLAYBACK_WRITE_SOURCES as readonly string[]).includes(value as string);
}
