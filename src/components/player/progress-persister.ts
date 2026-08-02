import type { PlayerBook } from "@/domain/player";
import {
  reconcileProgressConflict,
  shouldRetainMutation,
  nextDeviceSequence,
  toProgressBody,
  withProgressMutationLock,
} from "@/lib/offline-sync";
import { commitProgress, mirrorProgress } from "@/lib/offline/outbox";
import { getDeviceId, saveLocalPlaybackState, type PlaybackWriteSource } from "@/lib/playback-core";

/**
 * The MINIMUM GAP between two cadence-driven durable local writes — and, since
 * the timer below offers one every time it fires, also the cadence itself.
 *
 * TWO SOURCES, ONE GATE. The durable position is offered by both a timer of
 * this engine's own AND the audio element's `timeupdate`, and `writeDurableIfDue`
 * lets through whichever arrives first after this much time has passed. That is
 * deliberate, and it is about backgrounded audio specifically: the two sources
 * are throttled by completely different parts of the platform.
 *
 *   - `setInterval`/`setTimeout` is exactly what iOS suspends or coalesces when
 *     a page is backgrounded.
 *   - `timeupdate` is driven by the MEDIA PIPELINE, which is the one thing that
 *     is still running in a backgrounded audiobook, because it is what is
 *     producing the sound the user is listening to.
 *
 * Neither is guaranteed, and this repo cannot observe which of them survives a
 * real iOS backgrounding — that needs hardware. So the position rides on both,
 * and the user's place is lost only if BOTH stop at once. `tests/resume`'s
 * B3/B4 rows disable each source in turn and measure that the survivor alone
 * still bounds the loss.
 *
 * WHY A TIMER IS STILL HERE, given that `timeupdate` exists. `timeupdate` fires
 * about every 250 ms in WebKit and up to 60 Hz elsewhere, so a policy expressed
 * only in ticks has a write PHASE set by the engine — which is what decides
 * whether the last write before a kill happened 10 ms ago or 250 ms ago. The
 * timer samples `audio.currentTime` on a schedule of our own, so the worst-case
 * staleness is one interval on every engine, which is the property the bars are
 * stated in. The tick is the backstop for the timer, not a replacement for it.
 *
 * WHY 200 ms. Two failure shapes bound it, and they are the two the oracle
 * grades. A process killed with no callback at all (the app-switcher swipe, an
 * out-of-memory reap) can only come back as far as the last write: worst case
 * one interval, so 200 ms against a 1000 ms bar. A process that IS given a
 * lifecycle callback and then keeps playing before it is reaped — a
 * backgrounded audiobook, which is the normal way this app is used — is
 * protected by the synchronous flush on the callback AND by this cadence for
 * however long it lives after it; worst case is again one interval, against a
 * 250 ms bar. 250 ms of cadence would sit exactly ON that bar with no margin
 * for the write itself, and 500 ms (measured) misses it outright.
 *
 * WHY ADDING A SECOND SOURCE IS NOT WRITE AMPLIFICATION. The gate is shared:
 * `saveDurableState` stamps `lastDurableWriteAt` on every write it performs,
 * from any path, and `writeDurableIfDue` refuses any write inside the gap. So
 * the ceiling is one write per 200 ms — five per second — no matter how fast
 * the engine ticks, how many sources offer a position, or how fast the book is
 * playing. That is the same ceiling the single-writer build had; the second
 * source changes which writer satisfies the cadence, not how often it is
 * satisfied. And the timer skipping a turn because a tick beat it to it does
 * not stretch the gap: it reschedules a full interval from ITSELF, so the worst
 * case stays one interval plus the timer's own lateness. (MEASURED in WebKit
 * over the oracle's play window: 4.7-5.0 writes/s, and 0 while paused.)
 *
 * Both writers refuse a paused element, so a paused or idle player writes
 * nothing at all: five writes per second of one ~130-byte string is ~650 B/s of
 * logical writes only while audio is actually playing, and WebKit backs
 * `localStorage` with a coalescing write-behind flush, so the disk sees roughly
 * one small row update per second rather than five. Ten hours of listening is
 * on the order of 20 MB of logical writes against a flash endurance budget
 * measured in hundreds of terabytes.
 *
 * This is NOT a substitute for the lifecycle flush, and must not be read as
 * one. The synchronous write on the lifecycle edge is what has to be correct;
 * the cadence exists for the case where no edge is delivered at all, and for
 * the window between an edge and the kill that follows it.
 */
const DURABLE_SAVE_INTERVAL_MS = 200;
const SERVER_SAVE_INTERVAL_MS = 15_000;

/** What another device's winning write says about the book this device holds. */
export type ProgressConflictDetail = {
  userId: string;
  bookId: string;
  positionMs: number;
  completed: boolean;
  playbackRate: number;
};

export type ProgressPersisterDeps = {
  /** Read at call time so an account switch never writes under a stale user. */
  getUserId: () => string;
  getAudio: () => HTMLAudioElement | null;
  getActiveBook: () => PlayerBook | null;
};

export type ProgressPersister = ReturnType<typeof createProgressPersister>;

/**
 * Durable progress: the engine, framework-free.
 *
 * The shape that matters: `saveDurableState` writes the full playback tuple
 * synchronously, OUTSIDE the cross-tab lock and outside every IndexedDB
 * transaction, and every other durable path in this engine runs it first. The
 * server write, the outbox row and the mirror projection all sit behind awaits
 * and are best-effort; the local write is the one that has to land, because on
 * a terminating iOS page it is the only thing that can.
 *
 * Everything here is plain closures over plain mutable state — no React. The
 * `useProgressPersistence` hook wires this to the audio element's lifecycle
 * events and the page's lifecycle edges; the gate, cadence and flush semantics
 * all live here where a test can drive them without a component tree.
 */
export function createProgressPersister({
  getUserId,
  getAudio,
  getActiveBook,
}: ProgressPersisterDeps) {
  let lastServerSaveAt = 0;
  /**
   * When the durable local record was last written, by ANY path.
   *
   * This is the shared gate that keeps two cadence sources from becoming two
   * write rates. It is stamped inside `saveDurableState` rather than at the
   * call sites, so a user-driven write (a seek, a pause, the terminal flush)
   * counts against the same budget as a cadence write and cannot be doubled by
   * a tick arriving a millisecond later.
   */
  let lastDurableWriteAt = 0;
  const completion = new Map<string, boolean>();
  /**
   * Has anything happened to this book's position since it was opened?
   *
   * Opening a book, looking at it and closing it must not move where the user
   * left off. Smart rewind makes that a real hazard rather than a theoretical
   * one: the rewound start is a *proposal*, and writing it back turns a reading
   * aid into a position that walks backwards a little on every open. So a
   * terminal flush with no play, no seek and no rate change behind it writes
   * nothing at all.
   */
  let positionChanged = false;

  const markPositionChanged = () => {
    positionChanged = true;
  };

  /**
   * The synchronous durable write. No await before the `setItem`, by contract:
   * a `pagehide`/`visibilitychange` handler on iOS gets one task and may never
   * get a continuation.
   *
   * `source` names the MECHANISM that produced this write and leads the
   * signature so that no path can reach the durable record anonymously — the
   * whole point of the provenance is that a record with no `source` means the
   * build is old, not that a writer forgot to say who it was. It is metadata
   * riding along on a write that was happening anyway: nothing about what is
   * written, or when, depends on it.
   */
  const saveDurableState = (
    source: PlaybackWriteSource,
    positionMs?: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    const activeBook = bookOverride || getActiveBook();
    if (!activeBook) return;
    if (completed !== undefined) completion.set(activeBook.id, completed);
    if (!positionChanged) return;
    const audio = getAudio();
    const position = positionMs ?? (audio ? audio.currentTime * 1000 : 0);
    if (!Number.isFinite(position) || position < 0) return;
    lastDurableWriteAt = Date.now();
    saveLocalPlaybackState(getUserId(), activeBook.id, {
      positionMs: position,
      playbackRate: audio?.playbackRate || 1,
      completed: completed ?? completion.get(activeBook.id) ?? activeBook.completed,
      source,
      /**
       * WAS THERE STILL A SESSION RUNNING? Read off the element at the moment
       * of the write, from every path, for the same reason `source` is: the
       * record has to be able to describe itself.
       *
       * It matters most on the hide edge. `visibility-flush` and
       * `pagehide-flush` fire whether the user backgrounded a playing book or
       * a paused one, and only the first can be followed by listening the
       * device is unable to record. `detectSuspendedSession` reads this to
       * tell them apart; without it, closing a paused book would look exactly
       * like a suspended session and the user would be offered a jump forward
       * over content that never played.
       *
       * No new write occasion and no new read: `audio` is already in hand,
       * `paused` is a property access, and the field only appears on the
       * record when it is true.
       */
      playing: !!audio && !audio.paused,
    });
  };

  /**
   * The cadence write, from whichever source reaches it first.
   *
   * Both the timer and `timeupdate` come through here, so the guards are stated
   * once and cannot drift apart. NOTHING is written for an element that is gone
   * or paused: a `timeupdate` can still be dispatched after `pause()` (and is,
   * in WebKit), and the book-switch path in `playback-provider` pauses the
   * element before it re-points the active book, so this check is also what
   * stops one book's position being written under another book's key. The
   * caller's `positionMs` is used rather than a re-read of `currentTime`,
   * because the tick's own value is the one the engine reported.
   */
  const writeDurableIfDue = (source: PlaybackWriteSource, positionMs: number) => {
    const audio = getAudio();
    if (!audio || audio.paused || !getActiveBook()) return;
    if (Date.now() - lastDurableWriteAt < DURABLE_SAVE_INTERVAL_MS) return;
    saveDurableState(source, positionMs, false);
  };

  /**
   * The server half: the PATCH, and the outbox row when it cannot be sent.
   * Everything in here is behind an await and is allowed to never run — the
   * durable local write has already happened by the time this is called.
   */
  const sendProgress = async (
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    const activeBook = bookOverride || getActiveBook();
    if (!activeBook || !positionChanged) return;
    const durableCompleted = completed ?? completion.get(activeBook.id) ?? activeBook.completed;
    const playbackRate = getAudio()?.playbackRate || 1;
    const userId = getUserId();
    await withProgressMutationLock(activeBook.id, async () => {
      const event = {
        bookId: activeBook.id,
        deviceId: getDeviceId(),
        deviceSequence: await nextDeviceSequence(activeBook.id),
        positionMs: Math.round(positionMs),
        playbackRate,
        completed: durableCompleted,
        eventOccurredAt: new Date().toISOString(),
      };

      /**
       * ONLY the fetch is inside the try.
       *
       * `mirrorProgress` and `commitProgress` are both IndexedDB writes, and
       * with them under the same `catch` a storage fault was read as a
       * network fault: a failing `mirrorProgress` — Safari evicting the
       * database, a full quota, a blocked store — landed in the catch and
       * journalled an outbox row for an event the server had ALREADY
       * accepted, which the next replay then re-sent. A failing
       * `commitProgress` was worse: the catch ran `commitProgress` again, so
       * the one path that exists to make an unsent write durable retried
       * itself once, inside the lock, and then threw anyway.
       */
      let response: Response;
      try {
        response = await fetch(`/api/books/${activeBook.id}/progress`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: toProgressBody(event),
          keepalive: true,
        });
      } catch {
        // The request never reached a server, so the intent is unsent and has
        // to survive in the outbox.
        await commitProgress({ userId, ...event });
        return;
      }

      if (response.status === 409) {
        await reconcileProgressConflict({ userId, ...event }, response);
      } else if (response.ok) {
        // Accepted by the server, so there is no intent to journal — but
        // this device's own shelf still has to show it before the next pull.
        await mirrorProgress({ userId, ...event });
      } else if (shouldRetainMutation(response.status)) {
        await commitProgress({ userId, ...event });
      }
      /**
       * Everything else — 400, 404, 410, 413, 422 — is a REFUSAL, and the
       * `else` used to treat it as an acceptance. `shouldRetainMutation` only
       * claims a status is worth retrying; it never claimed the rest were
       * applied, and reading it that way mirrored writes the server had
       * rejected into the store the shelf renders from, with no outbox row to
       * ever correct them. A 404 for a book deleted on another device is the
       * live case: the card came back holding a position for a book that no
       * longer exists, and nothing would remove it.
       *
       * So a permanent refusal projects nothing and journals nothing. The
       * position is not lost — `saveDurableState` has already written it to
       * `localStorage`, which is this device's own record; what is dropped is
       * only the claim that the SERVER holds it.
       */
    });
  };

  /**
   * The durable write, then the server write. In that order, always.
   *
   * The returned promise never rejects. Every caller reaches this through
   * `void persistProgress(...)` from an event handler — a tap, a tick, a
   * lifecycle edge — and the server half is explicitly allowed to fail: it sits
   * behind a lock, a `fetch` and two IndexedDB writes, any of which can throw on
   * a device with storage evicted or blocked. Leaving those to escape turned a
   * best-effort background write into an unhandled rejection on the window,
   * which is a reported error for a case the design already calls survivable.
   * The durable local write has happened by the time this settles, so there is
   * nothing here for a caller to recover from.
   */
  const persistProgress = (
    source: PlaybackWriteSource,
    positionMs: number,
    completed?: boolean,
    bookOverride?: PlayerBook,
  ) => {
    saveDurableState(source, positionMs, completed, bookOverride);
    return sendProgress(positionMs, completed, bookOverride).catch(() => undefined);
  };

  /**
   * The listening loop: the durable write offered by the MEDIA PIPELINE, and
   * the server heartbeat.
   *
   * The durable write here is not a second cadence — it is the same cadence,
   * offered by a second source. It goes through `writeDurableIfDue`, so a fast
   * engine cannot raise the write rate above one per `DURABLE_SAVE_INTERVAL_MS`
   * and a slow one cannot lower the timer's. What it buys is the case this app
   * is actually used in: audio playing with the screen off, where iOS may
   * suspend the timer and the tick is the only thing still running. Removing it
   * (which this engine briefly did) means a backgrounded listening session with
   * a frozen timer records NO position for its entire length.
   */
  const onListeningTick = (positionMs: number) => {
    if (!getActiveBook()) return;
    writeDurableIfDue("media-tick", positionMs);
    if (Date.now() - lastServerSaveAt > SERVER_SAVE_INTERVAL_MS) {
      lastServerSaveAt = Date.now();
      void persistProgress("media-tick", positionMs, false);
    }
  };

  const markInProgress = () => {
    const activeBook = getActiveBook();
    if (activeBook) completion.set(activeBook.id, false);
    positionChanged = true;
  };

  /** A new book is on the element: nothing has happened to its position yet. */
  const resetPositionChanged = () => {
    positionChanged = false;
  };

  /**
   * Another device's write won a conflict. The provider owns the playback
   * surface (audio element and stores) and the ONE `PROGRESS_CONFLICT_EVENT`
   * listener; it calls this explicitly so the completion bookkeeping is
   * brought in step in a stated order rather than by two listeners racing on
   * registration order. The provider has already matched user and book.
   */
  const reconcileCompletion = (detail: ProgressConflictDetail) => {
    completion.set(detail.bookId, detail.completed);
  };

  /**
   * The cadence's own writer. Runs only while audio is actually playing, and
   * reads the element's own `currentTime` rather than anything the app cached.
   *
   * A SELF-RESCHEDULING TIMEOUT, not `setInterval`, and it reschedules to when
   * the next write is DUE rather than to a fixed grid.
   *
   * Both details are load-bearing, and the second was measured the hard way. A
   * shared gate means some other path — the terminal flush, the 15 s server
   * heartbeat, a seek, a pause — can write at an arbitrary phase and close the
   * gate on a timer callback that was already scheduled. Skipping that turn and
   * waiting a FULL interval from the skip puts the next cadence write up to two
   * intervals after the last one, which is not what the bars are stated in.
   * MEASURED, WebKit, that exact build: T2 pagehide came back 345 ms and 338 ms
   * behind against a 250 ms bar — the flush wrote, the timer's next turn was
   * refused, and the audio played on into the gap until the kill. Rescheduling
   * to `remaining` instead keeps the worst case one interval no matter who
   * wrote or when.
   *
   * THE FIRST ARM IS ALWAYS EXACTLY `DURABLE_SAVE_INTERVAL_MS`, and so is the
   * one after a write. Only the catch-up delay is shorter. `tests/resume`'s
   * `killDurableTimer` poison identifies this writer by that delay, and because
   * the chain can only ever START at the exact value, blocking it stops the
   * writer outright — no catch-up delay is ever scheduled for the poison to
   * miss, so B3 cannot go vacuously green.
   */
  let timer: number | null = null;
  const stopCadence = () => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const tick = () => {
    timer = null;
    const element = getAudio();
    // Nothing is playing any more, so the chain ends here rather than
    // spinning a timer for a paused player. `play` starts it again.
    if (!element || element.paused || !getActiveBook()) return;
    const remaining = DURABLE_SAVE_INTERVAL_MS - (Date.now() - lastDurableWriteAt);
    if (remaining > 0) {
      // Somebody else wrote inside this interval. Come back when the next
      // write is actually due, not a whole interval from now.
      timer = window.setTimeout(tick, remaining);
      return;
    }
    writeDurableIfDue("cadence-timer", element.currentTime * 1000);
    timer = window.setTimeout(tick, DURABLE_SAVE_INTERVAL_MS);
  };
  const startCadence = () => {
    if (timer !== null) return;
    timer = window.setTimeout(tick, DURABLE_SAVE_INTERVAL_MS);
  };

  return {
    persistProgress,
    onListeningTick,
    markInProgress,
    saveDurableState,
    markPositionChanged,
    resetPositionChanged,
    reconcileCompletion,
    startCadence,
    stopCadence,
  };
}
