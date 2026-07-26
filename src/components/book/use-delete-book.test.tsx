// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNLOAD_PLAYER_EVENT } from "@/lib/app-keys";
import { saveLocalPlaybackState } from "@/lib/playback-core";

const { commitBookDeletion, clearPlaybackHistoryForBook, removeOfflineBook, push, refresh } =
  vi.hoisted(() => ({
    commitBookDeletion: vi.fn(),
    clearPlaybackHistoryForBook: vi.fn(),
    removeOfflineBook: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
  }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/offline/outbox", () => ({ commitBookDeletion }));
vi.mock("@/lib/offline/deletion-journal", () => ({ removeOfflineBook }));
vi.mock("@/lib/playback-history", () => ({ clearPlaybackHistoryForBook }));
vi.mock("@/lib/offline-sync", () => ({ replayQueuedMutations: vi.fn().mockResolvedValue(0) }));

import { useDeleteBook } from "./use-delete-book";

const POSITION_KEY = "chapterline:position:user-a:book-1";
const MARKER_KEY = "chapterline:last-paused-at:user-a:book-1";

describe("deleting a book", () => {
  let unload: () => void;

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
    commitBookDeletion.mockReset().mockResolvedValue(undefined);
    clearPlaybackHistoryForBook.mockReset().mockResolvedValue(undefined);
    removeOfflineBook.mockReset().mockResolvedValue(undefined);

    /**
     * What the provider really does on this event. `unloadBook` makes the
     * position durable on its way out — correct for leaving a player, and the
     * reason a delete used to END by writing a fresh position record for the
     * book it had just destroyed. The test has to reproduce that write or it
     * grades a cleanup with nothing to clean up.
     */
    unload = () => saveLocalPlaybackState("user-a", "book-1", { positionMs: 42_000 });
    window.addEventListener(UNLOAD_PLAYER_EVENT, unload);
  });

  afterEach(() => {
    window.removeEventListener(UNLOAD_PLAYER_EVENT, unload);
    vi.unstubAllGlobals();
  });

  async function deleteThroughTheUi() {
    const onError = vi.fn();
    const { result } = renderHook(() => useDeleteBook("user-a", "book-1", onError));
    // First press arms the confirmation; second one deletes.
    await act(async () => void (await result.current.deleteBook()));
    await act(async () => void (await result.current.deleteBook()));
    return onError;
  }

  /**
   * F4. `healMirrorPlaybackFromLocal` sweeps every `chapterline:position:*` key
   * on launch and writes back any whose moment beats the mirror's. The delete
   * removes the book aggregate from IndexedDB; a surviving local record puts a
   * playback row for the deleted book straight back on the next launch, and on
   * every launch after that, because nothing ever removed the record feeding
   * it.
   */
  it("takes this device's local position for the book with it", async () => {
    localStorage.setItem(MARKER_KEY, String(Date.now()));
    const onError = await deleteThroughTheUi();

    expect(commitBookDeletion).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(POSITION_KEY),
      "the deleted book still has a local position record, and the next launch's heal pass " +
        "will resurrect a mirror playback row from it",
    ).toBeNull();
    expect(
      localStorage.getItem(MARKER_KEY),
      "the deleted book still has a pause marker; a re-import matched to the same book id by " +
        "fingerprint would inherit a smart rewind earned by the copy the user deleted",
    ).toBeNull();
  });

  it("leaves other books and other accounts alone", async () => {
    localStorage.setItem("chapterline:position:user-a:book-2", '{"positionMs":7,"occurredAt":1}');
    localStorage.setItem("chapterline:position:user-b:book-1", '{"positionMs":9,"occurredAt":1}');
    await deleteThroughTheUi();

    expect(localStorage.getItem("chapterline:position:user-a:book-2")).not.toBeNull();
    expect(localStorage.getItem("chapterline:position:user-b:book-1")).not.toBeNull();
  });

  it("does not touch the local position when the deletion could not be recorded", async () => {
    commitBookDeletion.mockRejectedValue(new Error("QuotaExceededError"));
    saveLocalPlaybackState("user-a", "book-1", { positionMs: 42_000 });
    const onError = await deleteThroughTheUi();

    expect(onError).toHaveBeenCalledOnce();
    expect(
      localStorage.getItem(POSITION_KEY),
      "the book was not deleted, so throwing away where the user was in it is pure data loss",
    ).not.toBeNull();
  });
});
