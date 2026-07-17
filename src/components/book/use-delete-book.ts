"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { UNLOAD_PLAYER_EVENT } from "@/lib/app-keys";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { clearPlaybackHistoryForBook } from "@/lib/playback-history";

/**
 * The one delete-book flow: confirm tap, server delete, player unload, local
 * history and media cleanup, then back to the library. Every delete entry
 * point shares this so no path forgets a cleanup step.
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
    const response = await fetch(`/api/books/${bookId}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      setDeleting(false);
      setConfirming(false);
      onError("The book could not be deleted. Check your connection and try again.");
      return;
    }
    window.dispatchEvent(new Event(UNLOAD_PLAYER_EVENT));
    await clearPlaybackHistoryForBook(userId, bookId).catch(() => undefined);
    await removeOfflineBook(userId, bookId).catch(() => {
      onError("The book was deleted, but device cleanup will retry automatically.");
    });
    router.push("/library");
    router.refresh();
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
