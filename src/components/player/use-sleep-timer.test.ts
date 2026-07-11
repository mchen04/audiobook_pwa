// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { PlayerChapter } from "@/domain/player";

import { useSleepTimer } from "./use-sleep-timer";

const chapters: PlayerChapter[] = [
  { id: "one", position: 0, title: "One", startMs: 0, endMs: 10_000 },
  { id: "two", position: 1, title: "Two", startMs: 10_000, endMs: 20_000 },
];

describe("chapter-end sleep", () => {
  it("stops when a throttled tick crosses into the next chapter", () => {
    const audio = { currentTime: 9.5, pause: vi.fn() } as unknown as HTMLAudioElement;
    const audioRef = { current: audio };
    const { result } = renderHook(() => useSleepTimer(audioRef));

    act(() => result.current.setSleepAtChapterEnd(9_500, chapters));
    audio.currentTime = 10.25;
    act(() => result.current.onTimeUpdate(audio));

    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(10);
  });
});
