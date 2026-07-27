// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveLocalPlaybackState } from "@/lib/playback-core";

import { useSuspensionRecovery } from "./use-suspension-recovery";

const DURATION_MS = 3_600_000;
const KEY = "chapterline:position:user-a:book-1";
const DISMISSED_KEY = "chapterline:suspension-dismissed:user-a:book-1";

/**
 * The player-side half of the recovery path: what the user is offered, once,
 * and what happens to the offer when they answer it.
 *
 * The detection rule and the projection maths are `playback-core.test.ts`; the
 * end-to-end behaviour in WebKit is `tests/resume/suspension-recovery.spec.ts`.
 * This covers the part neither can see — that the offer survives the render and
 * that a dismissal STICKS, which is a promise about the next launch and so
 * cannot be kept in memory.
 */
describe("useSuspensionRecovery", () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** A hide-edge record written `agoMs` ago with the book still playing. */
  function seedSuspension(agoMs: number, positionMs = 1_800_000): number {
    const writtenAt = Date.now() - agoMs;
    vi.setSystemTime(new Date(writtenAt));
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs,
      source: "visibility-flush",
      playbackRate: 1,
      playing: true,
    });
    vi.setSystemTime(new Date(writtenAt + agoMs));
    return writtenAt;
  }

  function mount() {
    return renderHook(() =>
      useSuspensionRecovery({ userId: "user-a", bookId: "book-1", durationMs: DURATION_MS }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(10_000_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the gap the record describes", async () => {
    const writtenAt = seedSuspension(300_000);
    const { result } = mount();
    await waitFor(() => expect(result.current.gap).not.toBeNull());
    expect(result.current.gap).toStrictEqual({
      recordedPositionMs: 1_800_000,
      writtenAt,
      elapsedMs: 300_000,
      playbackRate: 1,
      projectedPositionMs: 2_100_000,
    });
  });

  it("offers nothing when the last write was a cadence writer", async () => {
    seedSuspension(300_000);
    // Something DID write after the hide edge, so there is no unrecorded
    // stretch. The record is otherwise identical.
    saveLocalPlaybackState("user-a", "book-1", {
      positionMs: 1_900_000,
      source: "cadence-timer",
      playing: true,
    });
    const { result } = mount();
    await act(async () => undefined);
    expect(result.current.gap).toBeNull();
  });

  /**
   * A dismissal is a promise about the NEXT launch, so it has to outlive the
   * component. Kept in state it would come straight back the next time the user
   * tapped the book, which is the annoyance this whole affordance is trying not
   * to be.
   */
  it("keeps a dismissal across a fresh mount of the same gap", async () => {
    const writtenAt = seedSuspension(300_000);
    const first = mount();
    await waitFor(() => expect(first.result.current.gap).not.toBeNull());
    act(() => first.result.current.dismiss());
    expect(first.result.current.gap).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe(String(writtenAt));
    first.unmount();

    const second = mount();
    await act(async () => undefined);
    expect(
      second.result.current.gap,
      "the dismissed offer came back on the next open, so the user has to dismiss the same " +
        "estimate every time they reach for this book",
    ).toBeNull();
  });

  /**
   * The answer was about one unrecorded stretch, not about the book. A second
   * suspension is a second loss and the user has said nothing about it.
   */
  it("offers a later gap even after an earlier one was dismissed", async () => {
    seedSuspension(300_000);
    const first = mount();
    await waitFor(() => expect(first.result.current.gap).not.toBeNull());
    act(() => first.result.current.dismiss());
    first.unmount();

    vi.setSystemTime(new Date(20_000_000));
    const writtenAt = seedSuspension(600_000);
    const second = mount();
    await waitFor(() => expect(second.result.current.gap).not.toBeNull());
    expect(second.result.current.gap?.writtenAt).toBe(writtenAt);
    expect(second.result.current.gap?.elapsedMs).toBe(600_000);
  });

  it("offers nothing at all when this device holds no record for the book", async () => {
    localStorage.removeItem(KEY);
    const { result } = mount();
    await act(async () => undefined);
    expect(result.current.gap).toBeNull();
  });
});
