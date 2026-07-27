"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { UNLOAD_PLAYER_EVENT } from "@/lib/app-keys";
import { replayQueuedMutations } from "@/lib/offline-sync";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { commitBookDeletion } from "@/lib/offline/outbox";
import { clearLocalPlaybackState, getDeviceId } from "@/lib/playback-core";
import { clearPlaybackHistoryForBook } from "@/lib/playback-history";

/**
 * The one delete-book flow: confirm tap, journalled delete, player unload,
 * local history and media cleanup, then back to the library. Every delete entry
 * point shares this so no path forgets a cleanup step.
 *
 * The delete is queued rather than sent, so it survives a close, a crash and a
 * flat connection. That ordering matters in one direction only: the intent is
 * durable *before* this device destroys the only copy of the audio, so the
 * server can never be left holding a book whose bytes are already gone.
 */
export function useDeleteBook(userId: string, bookId: string, onError: (message: string) => void) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function deleteBook() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    try {
      await commitBookDeletion({ userId, deviceId: getDeviceId() }, bookId);
    } catch {
      setDeleting(false);
      setConfirming(false);
      onError("This device could not record the deletion. Try again.");
      return;
    }
    window.dispatchEvent(new Event(UNLOAD_PLAYER_EVENT));
    // AFTER the unload, never before. `UNLOAD_PLAYER_EVENT` is dispatched
    // synchronously and `unloadBook` makes the position durable on its way out
    // — correct for leaving a player, wrong for a book that is being destroyed.
    // Clearing first would simply be overwritten by that write; clearing here
    // removes it, and with it the local record that `healMirrorPlaybackFromLocal`
    // would otherwise use to resurrect a playback row for a deleted book on
    // every launch.
    clearLocalPlaybackState(userId, bookId);
    await clearPlaybackHistoryForBook(userId, bookId).catch(() => undefined);
    await removeOfflineBook(userId, bookId).catch(() => {
      onError("The book was deleted, but device cleanup will retry automatically.");
    });
    void replayQueuedMutations(userId).catch(() => undefined);
    router.push("/library");
    if (navigator.onLine) router.refresh();
  }

  return {
    deleteBook,
    deleting,
    deleteLabel: deleting
      ? "Deleting"
      : confirming
        ? "Tap again to permanently delete"
        : "Delete this book",
  };
}
