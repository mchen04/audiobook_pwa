// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerBook } from "@/domain/player";

const { commitProgress, mirrorProgress, reconcileProgressConflict, replayQueuedMutations } =
  vi.hoisted(() => ({
    commitProgress: vi.fn(),
    mirrorProgress: vi.fn(),
    reconcileProgressConflict: vi.fn(),
    replayQueuedMutations: vi.fn(),
  }));

vi.mock("@/lib/offline/outbox", () => ({ commitProgress, mirrorProgress }));
vi.mock("@/lib/offline-sync", async () => {
  const actual = await vi.importActual<typeof import("@/lib/offline-sync")>("@/lib/offline-sync");
  return {
    ...actual,
    reconcileProgressConflict,
    replayQueuedMutations,
    nextDeviceSequence: vi.fn().mockResolvedValue(1),
    withProgressMutationLock: (_bookId: string, run: () => Promise<void>) => run(),
  };
});

import { nextDeviceSequence } from "@/lib/offline-sync";

import { useProgressPersistence } from "./use-progress-persistence";

const book: PlayerBook = {
  id: "book-1",
  title: "Test Book",
  author: "Test Author",
  durationMs: 60_000,
  mediaUrl: "/offline-media/test",
  coverUrl: null,
  chapters: [],
  initialPositionMs: 0,
  initialProgressOccurredAt: null,
  initialPlaybackRate: 1,
  completed: false,
};

function mountHook({ paused = true }: { paused?: boolean } = {}) {
  const audio = {
    currentTime: 12,
    playbackRate: 1,
    paused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLAudioElement;
  const audioRef = { current: audio };
  const activeBookRef = { current: book };
  const { result } = renderHook(() => useProgressPersistence("user-a", audioRef, activeBookRef));
  // Nothing is written for a book whose position has not moved on this open;
  // these rows are about a real listening session, so say so.
  result.current.markInProgress();
  return result;
}

function respondWith(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(status === 204 ? null : "{}", { status })),
  );
}

describe("the server half of a progress write", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    commitProgress.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    reconcileProgressConflict.mockReset().mockResolvedValue(undefined);
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects an accepted write to the shelf and journals nothing", async () => {
    respondWith(200);
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(commitProgress).not.toHaveBeenCalled();
  });

  it("journals a retryable rejection and projects nothing", async () => {
    respondWith(503);
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  /**
   * F3. `shouldRetainMutation` answers "is this worth retrying", and the `else`
   * branch read it as "was this accepted". Everything it says no to that is not
   * a 2xx — 400, 404, 410, 413, 422 — was therefore mirrored into the store the
   * shelf renders from as if the server held it, with no outbox row to ever
   * correct it. A 404 is the live case: the book was deleted on another device,
   * the write is refused forever, and the card kept showing a position for it.
   */
  for (const status of [400, 404, 410, 413, 422]) {
    it(`neither projects nor journals a permanently refused write (${status})`, async () => {
      respondWith(status);
      const result = mountHook();
      await result.current.persistProgress("pause", 12_000);
      expect(
        mirrorProgress,
        `a ${status} is a refusal; mirroring it tells this device's shelf the server holds a ` +
          "position it rejected",
      ).not.toHaveBeenCalled();
      expect(
        commitProgress,
        `a ${status} will be refused again on every replay, so journalling it queues a write ` +
          "that can never drain",
      ).not.toHaveBeenCalled();
    });
  }

  it("journals a write that never reached a server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
    expect(mirrorProgress).not.toHaveBeenCalled();
  });

  /**
   * F3b. `mirrorProgress` used to sit inside the same `try` as the `fetch`, so
   * a storage fault was indistinguishable from a network fault: the server had
   * already accepted the event, IndexedDB failed to project it, and the catch
   * journalled an outbox row that the next replay re-sent.
   */
  it("does not journal an accepted write when the local projection is what failed", async () => {
    respondWith(200);
    mirrorProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(mirrorProgress).toHaveBeenCalledOnce();
    expect(
      commitProgress,
      "the server accepted this write; a failure to project it locally is not an unsent intent",
    ).not.toHaveBeenCalled();
  });

  /**
   * F3b, the other half. The catch used to re-run the very call that had just
   * thrown, inside the mutation lock, and then reject anyway.
   */
  it("does not retry the outbox write that just failed", async () => {
    respondWith(503);
    commitProgress.mockRejectedValue(new Error("QuotaExceededError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(commitProgress).toHaveBeenCalledOnce();
  });

  /**
   * F10. Every caller reaches this through `void persistProgress(...)`, so a
   * rejection escaping it is an unhandled rejection on the window for a case
   * the design already calls survivable.
   */
  it("never rejects, whatever the storage layer does", async () => {
    respondWith(200);
    // `nextDeviceSequence` is an IndexedDB read, and it is awaited before the
    // request is even built — outside every `catch` in this hook. On a device
    // with the database evicted it is the first thing to throw.
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await expect(result.current.persistProgress("pause", 12_000)).resolves.toBeUndefined();
  });

  it("still writes the durable local position when the server half throws", async () => {
    respondWith(200);
    vi.mocked(nextDeviceSequence).mockRejectedValueOnce(new Error("InvalidStateError"));
    const result = mountHook();
    await result.current.persistProgress("pause", 12_000);
    expect(JSON.parse(localStorage.getItem("chapterline:position:user-a:book-1")!)).toMatchObject({
      positionMs: 12_000,
    });
  });
});

/**
 * The two durable writers, and the one gate between them.
 *
 * The position is offered by a timer AND by `timeupdate` because iOS throttles
 * those two through completely different machinery: a backgrounded page loses
 * its timers, while `timeupdate` is produced by the media pipeline that is
 * still decoding the audio the user is listening to. Each has to be able to
 * carry the position ALONE — that is the whole reason for having two — and
 * together they must not raise the write rate, which is what the shared
 * `DURABLE_SAVE_INTERVAL_MS` gate is for.
 *
 * `tests/resume`'s B3/B4 rows measure the same property end to end in WebKit,
 * against a real audio element and a real process kill. These are the fast,
 * deterministic version: they can disable a source outright and count writes
 * exactly, which the browser rows cannot.
 */
describe("the durable cadence, with two sources", () => {
  const KEY = "chapterline:position:user-a:book-1";
  const INTERVAL_MS = 200;

  /** A minimal media element whose `paused` this test controls. */
  class FakeAudio extends EventTarget {
    currentTime = 12;
    playbackRate = 1;
    paused = true;
  }

  let writes: number[];
  /** The full record behind each write, for the provenance rows. */
  let records: Array<{ positionMs: number; source?: string }>;
  const sources = () => records.map((record) => record.source);

  beforeEach(() => {
    writes = [];
    records = [];
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === KEY) {
          const record = JSON.parse(value) as { positionMs: number; source?: string };
          writes.push(record.positionMs);
          records.push(record);
        }
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    commitProgress.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Mounts the hook on a playing element and returns both halves of it. */
  function playing() {
    const audio = new FakeAudio();
    const audioRef = { current: audio as unknown as HTMLAudioElement };
    const activeBookRef = { current: book };
    const { result, unmount } = renderHook(() =>
      useProgressPersistence("user-a", audioRef, activeBookRef),
    );
    result.current.markInProgress();
    audio.paused = false;
    audio.dispatchEvent(new Event("play"));
    return { audio, result, unmount };
  }

  /** Plays for `ms`, delivering a `timeupdate` every `tickMs` if asked. */
  function listen(
    audio: FakeAudio,
    result: { current: { onListeningTick: (positionMs: number) => void } },
    { ms, tickMs }: { ms: number; tickMs: number | null },
  ) {
    const step = 10;
    let sinceTick = 0;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      vi.advanceTimersByTime(step);
      audio.currentTime += step / 1000;
      if (tickMs === null) continue;
      sinceTick += step;
      if (sinceTick < tickMs) continue;
      sinceTick = 0;
      if (!audio.paused) result.current.onListeningTick(audio.currentTime * 1000);
    }
  }

  /**
   * B4's unit twin: `timeupdate` never reaches the hook, so the timer is the
   * only writer left. This is the source iOS is MOST likely to keep, and the
   * one that was already there — but if it ever stopped being able to carry the
   * position on its own, B4 would be the only thing to notice.
   */
  it("keeps writing with no timeupdate at all", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 2_000, tickMs: null });
    expect(writes.length, "the timer alone wrote nothing over two seconds").toBeGreaterThanOrEqual(
      9,
    );
    expect(writes.at(-1)).toBeGreaterThan(writes[0]!);
    unmount();
  });

  /**
   * B3's unit twin, and the regression `8afb574` introduced: with the timer
   * frozen — which is what iOS does to a backgrounded page — the position has
   * to keep being recorded off the media pipeline's own tick. Before this fix
   * the count here was ZERO for the entire session.
   */
  it("keeps writing with the timer frozen", () => {
    const frozen = vi.spyOn(window, "setTimeout").mockImplementation(() => 0 as never);
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 2_000, tickMs: 250 });
    frozen.mockRestore();
    expect(
      writes.length,
      "with the timer dead the timeupdate tick wrote nothing, so a backgrounded listening " +
        "session would record no position at all",
    ).toBeGreaterThanOrEqual(7);
    expect(writes.at(-1)).toBeGreaterThan(writes[0]!);
    unmount();
  });

  /**
   * The never-cross rule. Two sources must not mean two write rates: the gate
   * is shared, so the ceiling is one write per interval however fast the engine
   * ticks. A 60 Hz engine is the adversarial case — it offers a position 12
   * times per interval.
   */
  it("does not amplify the write rate when both sources are alive", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 4_000, tickMs: 16 });
    const ceiling = 4_000 / INTERVAL_MS + 1;
    expect(
      writes.length,
      `${writes.length} durable writes in 4s with a 60Hz tick and a ${INTERVAL_MS}ms timer; the ` +
        `shared gate caps this at ${ceiling}`,
    ).toBeLessThanOrEqual(ceiling);
    // And it must not have COST anything either: the cadence still has to be met.
    expect(writes.length, "the cadence stopped being met").toBeGreaterThanOrEqual(18);
    unmount();
  });

  /**
   * The regression the shared gate introduced, and the reason the timer
   * reschedules to `remaining` rather than to a fixed interval.
   *
   * A gate that any path can satisfy means any path can also CLOSE it. The
   * terminal flush, the 15 s server heartbeat, a seek and a pause all write
   * unconditionally, at whatever phase the user happened to act — and a timer
   * that answers a refused turn by waiting a full interval from the refusal
   * puts the next cadence write up to TWO intervals after the last one.
   *
   * That is not theoretical. MEASURED in WebKit on the build that had it: T2
   * pagehide (the flush fires, then the audio plays on until the process is
   * killed) came back 345 ms and 338 ms behind a 250 ms bar, where the same row
   * reads single digits with this fixed. The bars are stated in "one interval",
   * so the gap has to BE one interval whoever wrote and whenever.
   */
  it("an out-of-band write must not stretch the cadence to two intervals", () => {
    const { audio, result, unmount } = playing();
    const at: number[] = [];
    const store = localStorage.setItem.bind(localStorage);
    vi.stubGlobal("localStorage", {
      ...localStorage,
      setItem: (key: string, value: string) => {
        if (key === KEY) at.push(Date.now());
        store(key, value);
      },
    } as unknown as Storage);

    // Settle onto the cadence, then have somebody else write mid-interval —
    // which is exactly what the flush and the heartbeat do.
    listen(audio, result, { ms: 1_000, tickMs: null });
    vi.advanceTimersByTime(90);
    result.current.saveDurableState("visibility-flush", audio.currentTime * 1000);
    listen(audio, result, { ms: 2_000, tickMs: null });

    const gaps = at.slice(1).map((value, index) => value - at[index]!);
    expect(gaps.length, "not enough writes to measure a gap").toBeGreaterThan(8);
    expect(
      Math.max(...gaps),
      `the longest gap between two durable writes was ${Math.max(...gaps)}ms after an out-of-band ` +
        `write landed mid-interval (gaps ${JSON.stringify(gaps)}). The cadence is ${INTERVAL_MS}ms ` +
        "and every bar in `tests/resume` is stated as one interval, so a write that closes the " +
        "gate must delay the next cadence write to when it is DUE, not to a full interval after " +
        "the turn it refused.",
    ).toBeLessThanOrEqual(INTERVAL_MS + 20);
    unmount();
  });

  it("writes nothing at all while the element is paused", () => {
    const { audio, result, unmount } = playing();
    listen(audio, result, { ms: 1_000, tickMs: 250 });
    const whilePlaying = writes.length;
    expect(whilePlaying).toBeGreaterThan(0);

    audio.paused = true;
    audio.dispatchEvent(new Event("pause"));
    writes.length = 0;
    // A tick after `pause()` is not hypothetical — WebKit dispatches one.
    listen(audio, result, { ms: 5_000, tickMs: 250 });
    result.current.onListeningTick(99_000);
    expect(
      writes,
      "a paused player wrote its position, so the write rate is not zero at rest",
    ).toStrictEqual([]);
    unmount();
  });

  /**
   * WHICH writer wrote it, recorded on the record itself.
   *
   * `docs/resume-durability-device-check.md` turns on one question no
   * instrument here can answer: does iOS suspend the 200 ms timer AND
   * `timeupdate` at the same time while a backgrounded PWA plays? These rows
   * pin the part that IS testable — that each mechanism signs its own writes —
   * so that reading the record on a real phone answers the rest. If the tick
   * and the timer both wrote `"cadence-timer"`, the check would come back
   * "the timer survived" no matter which writer actually did.
   */
  it("signs a tick-driven write as the media pipeline and a timer-driven one as the timer", () => {
    const { audio, result, unmount } = playing();

    // No timer advance at all, so only the tick can have written these.
    result.current.onListeningTick(audio.currentTime * 1000);
    const fromTick = records.length;
    expect(fromTick).toBeGreaterThan(0);
    expect(
      new Set(sources()),
      "a write the media pipeline produced is not signed `media-tick`, so a phone whose timer " +
        "had been suspended could not tell that the tick was what kept the position current",
    ).toStrictEqual(new Set(["media-tick"]));

    // No tick at all, so only the timer can have written these.
    vi.advanceTimersByTime(INTERVAL_MS * 2);
    expect(records.length).toBeGreaterThan(fromTick);
    expect(
      new Set(sources().slice(fromTick)),
      "the timer's writes are being attributed to another writer, so a phone that had suspended " +
        "`timeupdate` would still report the tick as alive",
    ).toStrictEqual(new Set(["cadence-timer"]));
    unmount();
  });

  /** Neither source may put a book's position under a different book's key. */
  it("writes nothing once the active book is gone", () => {
    const audio = new FakeAudio();
    const audioRef = { current: audio as unknown as HTMLAudioElement };
    const activeBookRef: { current: PlayerBook | null } = { current: book };
    const { result, unmount } = renderHook(() =>
      useProgressPersistence("user-a", audioRef, activeBookRef),
    );
    result.current.markInProgress();
    audio.paused = false;
    audio.dispatchEvent(new Event("play"));
    activeBookRef.current = null;
    writes.length = 0;
    listen(audio, result, { ms: 2_000, tickMs: 250 });
    expect(writes).toStrictEqual([]);
    unmount();
  });
});

/**
 * The lifecycle flush, and the plumbing between a caller and the record.
 *
 * The flush is the writer that matters most to
 * `docs/resume-durability-device-check.md`: if a five-minute backgrounded
 * listen comes back showing `visibility-flush` with a five-minute-old
 * `writtenAt`, then NOTHING wrote after the page was hidden and both cadence
 * writers were suspended. That reading only means anything if the flush signs
 * itself, and if the two lifecycle edges are told apart — an app-switcher kill
 * delivers neither, a backgrounding delivers only the first.
 */
describe("the provenance of a lifecycle write", () => {
  const KEY = "chapterline:position:user-a:book-1";

  beforeEach(() => {
    // These rows dispatch real lifecycle events at the document and the window,
    // so every hook still mounted from an earlier row would answer them too.
    cleanup();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as Storage);
    vi.stubGlobal("crypto", { randomUUID: () => "device-1" } as Crypto);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    commitProgress.mockReset().mockResolvedValue(undefined);
    mirrorProgress.mockReset().mockResolvedValue(undefined);
    replayQueuedMutations.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const storedSource = () => (JSON.parse(localStorage.getItem(KEY)!) as { source?: string }).source;

  it("signs the hidden edge as the visibility flush", () => {
    mountHook();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    expect(storedSource()).toBe("visibility-flush");
  });

  it("signs a terminal pagehide apart from a backgrounding", () => {
    mountHook();
    window.dispatchEvent(new Event("pagehide"));
    expect(
      storedSource(),
      "the two lifecycle edges write the same source, so the readout cannot distinguish a page " +
        "that was backgrounded from one that was torn down",
    ).toBe("pagehide-flush");
  });

  /**
   * Every other write path reaches the record through `persistProgress`, so the
   * mechanism each of them names has to survive the trip verbatim. The call
   * sites themselves are pinned in `playback-provider.history.test.tsx` and
   * `use-transport-actions.test.ts`.
   */
  it("carries a caller's mechanism through to the record unchanged", async () => {
    for (const source of ["pause", "seek", "ended", "rate-change", "book-unload"] as const) {
      const result = mountHook();
      await result.current.persistProgress(source, 12_000);
      expect(storedSource()).toBe(source);
    }
  });

  const storedLiveness = () =>
    (JSON.parse(localStorage.getItem(KEY)!) as { playingAtWrite?: boolean }).playingAtWrite;

  /**
   * THE OTHER HALF OF THE SIGNATURE. `visibility-flush` with a stale
   * `writtenAt` says nothing wrote after the page was hidden — but a hide edge
   * is taken on EVERY backgrounding, and only one taken while audio was live
   * can have unrecorded listening behind it. `detectSuspendedSession` reads
   * this to tell a suspended listening session from a user who paused and put
   * the phone in their pocket, and the whole recovery offer hangs off it.
   */
  it("records that the hidden edge caught a live listening session", () => {
    mountHook({ paused: false });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockRestore();
    expect(storedSource()).toBe("visibility-flush");
    expect(
      storedLiveness(),
      "the hide-edge write does not record that audio was playing, so a suspended listening " +
        "session is indistinguishable from a book backgrounded while paused and no lost " +
        "stretch can ever be detected",
    ).toBe(true);
  });

  it("records nothing of the sort for a hide edge taken while paused", () => {
    mountHook({ paused: true });
    window.dispatchEvent(new Event("pagehide"));
    expect(storedSource()).toBe("pagehide-flush");
    expect(
      storedLiveness(),
      "a hide edge taken while the book was PAUSED claims audio was live, which would offer to " +
        "move the user forward over content that never played",
    ).toBeUndefined();
  });
});
