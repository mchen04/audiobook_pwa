"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Bookmark } from "@/domain/player";
import { formatClock } from "@/lib/format-time";
import { projectOfflineBookmark } from "@/lib/offline-library";
import {
  broadcastBookmarkReconciliation,
  completeBookmarkDelete,
  completeBookmarkClientDeleteIfPresent,
  completeBookmarkUpdate,
  isRetryableMutationStatus,
  queueBookmark,
  queueBookmarkClientDelete,
  queueBookmarkDelete,
  queueBookmarkUpdate,
  queuedBookmarksFor,
  removeQueuedBookmark,
  removeQueuedBookmarkSnapshot,
  updateQueuedBookmarkNote,
  shouldRetainMutation,
  withBookmarkMutationLock,
  type QueuedBookmark,
} from "@/lib/offline-sync";
import { isBookmarkPayload, readJson } from "@/lib/wire";

const PENDING_PREFIX = "pending:";

/**
 * Optimistic bookmark list for one book: every action applies locally first,
 * syncs in the background, queues offline, and survives the delete-while-
 * creating race by removing the just-created server row when it lands.
 */
export function useBookmarks(userId: string, bookId: string, initialBookmarks: Bookmark[]) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(initialBookmarks);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<number | null>(null);
  const deletedWhileSyncingRef = useRef(new Set<string>());

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(null), 4_000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => queuedBookmarksFor(userId, bookId))
      .then((entries) => entries.map(asPendingBookmark))
      .then((pending) => {
        if (!active || !pending.length) return;
        setBookmarks((current) => {
          const known = new Set(current.map((bookmark) => bookmark.id));
          return sortByPosition([...current, ...pending.filter((entry) => !known.has(entry.id))]);
        });
      });
    return () => {
      active = false;
    };
  }, [bookId, userId]);

  useEffect(() => {
    const reject = (event: Event) => {
      const detail = (event as CustomEvent<BookmarkRejectedDetail>).detail;
      if (detail.userId !== userId || detail.bookId !== bookId) return;
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== detail.bookmarkId));
      showNotice("A bookmark change was rejected by the server and removed from this device.");
    };
    window.addEventListener("chapterline:bookmark-rejected", reject);
    return () => window.removeEventListener("chapterline:bookmark-rejected", reject);
  }, [bookId, showNotice, userId]);

  useEffect(() => {
    const apply = (detail: BookmarkReconciliationDetail) => {
      if (detail.userId !== userId || detail.bookId !== bookId) return;
      setBookmarks((current) =>
        detail.kind === "delete"
          ? current.filter((bookmark) => bookmark.id !== detail.bookmarkId)
          : detail.kind === "note"
            ? current.map((bookmark) =>
                bookmark.id === detail.bookmarkId ? { ...bookmark, note: detail.note } : bookmark,
              )
            : sortByPosition([
                ...current.filter(
                  (bookmark) =>
                    bookmark.id !== detail.bookmark.id && bookmark.id !== detail.pendingId,
                ),
                detail.bookmark,
              ]),
      );
    };
    const onCustom = (event: Event) =>
      apply((event as CustomEvent<BookmarkReconciliationDetail>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "chapterline:bookmark-reconciled" || !event.newValue) return;
      try {
        apply(JSON.parse(event.newValue) as BookmarkReconciliationDetail);
      } catch {
        // Ignore malformed or extension-modified storage events.
      }
    };
    window.addEventListener("chapterline:bookmark-reconciled", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("chapterline:bookmark-reconciled", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, [bookId, userId]);

  const syncBookmark = useCallback(
    async (entry: QueuedBookmark) => {
      try {
        let syncing = entry;
        while (true) {
          const response = await fetch(`/api/books/${bookId}/bookmarks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              positionMs: syncing.positionMs,
              note: syncing.note,
              clientId: syncing.clientId,
            }),
          });
          if (isRetryableMutationStatus(response.status)) return;
          if (response.status === 401 || response.status === 403) {
            showNotice("Sign in again to sync this bookmark.");
            return;
          }
          const payload = await readJson(response, isBookmarkPayload);
          const outcome = await withBookmarkMutationLock(
            userId,
            bookId,
            pendingId(entry.clientId),
            async () => {
              if (!payload) {
                deletedWhileSyncingRef.current.delete(entry.clientId);
                await completeBookmarkClientDeleteIfPresent(entry, fetch, true);
                await removeQueuedBookmark(userId, entry.clientId);
                await projectOfflineBookmark(userId, bookId, {
                  kind: "delete",
                  bookmarkId: pendingId(entry.clientId),
                });
                setBookmarks((current) =>
                  current.filter((item) => item.id !== pendingId(entry.clientId)),
                );
                return null;
              }
              if (deletedWhileSyncingRef.current.delete(entry.clientId)) {
                await removeQueuedBookmark(userId, entry.clientId);
                await projectOfflineBookmark(userId, bookId, {
                  kind: "delete",
                  bookmarkId: pendingId(entry.clientId),
                });
                await completeBookmarkClientDeleteIfPresent(entry, fetch, true);
                return null;
              }
              if (await completeBookmarkClientDeleteIfPresent(entry, fetch, true)) {
                await removeQueuedBookmark(userId, entry.clientId);
                await projectOfflineBookmark(userId, bookId, {
                  kind: "delete",
                  bookmarkId: pendingId(entry.clientId),
                });
                setBookmarks((current) =>
                  current.filter((item) => item.id !== pendingId(entry.clientId)),
                );
                return null;
              }
              await removeQueuedBookmarkSnapshot(syncing);
              const latest = (await queuedBookmarksFor(userId, bookId)).find(
                (queued) => queued.clientId === entry.clientId,
              );
              if (latest) return latest;
              await projectOfflineBookmark(userId, bookId, {
                kind: "delete",
                bookmarkId: pendingId(entry.clientId),
              });
              await projectOfflineBookmark(userId, bookId, {
                kind: "upsert",
                bookmark: payload.bookmark,
              });
              setBookmarks((current) =>
                current.map((item) =>
                  item.id === pendingId(entry.clientId) ? payload.bookmark : item,
                ),
              );
              broadcastBookmarkReconciliation(
                { userId, bookId },
                {
                  kind: "upsert",
                  bookmark: payload.bookmark,
                  pendingId: pendingId(entry.clientId),
                },
              );
              return null;
            },
          );
          if (!outcome) return;
          syncing = outcome;
        }
      } catch {
        if (deletedWhileSyncingRef.current.delete(entry.clientId)) {
          await removeQueuedBookmark(userId, entry.clientId);
          await projectOfflineBookmark(userId, bookId, {
            kind: "delete",
            bookmarkId: pendingId(entry.clientId),
          });
          broadcastBookmarkReconciliation(
            { userId, bookId },
            { kind: "delete", bookmarkId: pendingId(entry.clientId) },
          );
        }
      }
    },
    [bookId, showNotice, userId],
  );

  const addBookmark = useCallback(
    (positionMs: number) => {
      const entry: QueuedBookmark = {
        userId,
        bookId,
        clientId: crypto.randomUUID(),
        positionMs: Math.round(positionMs),
        note: null,
        createdAt: new Date().toISOString(),
        revision: 1,
      };
      void queueBookmark(entry)
        .then(async () => {
          await projectOfflineBookmark(userId, bookId, {
            kind: "upsert",
            bookmark: asPendingBookmark(entry),
          });
          setBookmarks((current) => sortByPosition([...current, asPendingBookmark(entry)]));
          showNotice(`Bookmark saved at ${formatClock(entry.positionMs)}.`);
          return syncBookmark(entry);
        })
        .catch(() => showNotice("This device could not save the bookmark."));
    },
    [bookId, showNotice, syncBookmark, userId],
  );

  const deleteBookmark = useCallback(
    async (bookmark: Bookmark) => {
      if (bookmark.id.startsWith(PENDING_PREFIX)) {
        const clientId = bookmark.id.slice(PENDING_PREFIX.length);
        await withBookmarkMutationLock(userId, bookId, bookmark.id, async () => {
          setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
          deletedWhileSyncingRef.current.add(clientId);
          await queueBookmarkClientDelete({ userId, bookId, clientId });
          await projectOfflineBookmark(userId, bookId, {
            kind: "delete",
            bookmarkId: bookmark.id,
          });
          broadcastBookmarkReconciliation(
            { userId, bookId },
            { kind: "delete", bookmarkId: bookmark.id },
          );
          await completeBookmarkClientDeleteIfPresent({
            userId,
            bookId,
            clientId,
            positionMs: bookmark.positionMs,
            note: bookmark.note,
            createdAt: bookmark.createdAt,
            revision: 1,
          });
        });
        return;
      }
      const queued = await withBookmarkMutationLock(userId, bookId, bookmark.id, async () => {
        const entry = await queueBookmarkDelete({
          userId,
          bookId,
          bookmarkId: bookmark.id,
        });
        setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
        await projectOfflineBookmark(userId, bookId, {
          kind: "delete",
          bookmarkId: bookmark.id,
        });
        return entry;
      });
      const response = await fetch(`/api/books/${bookId}/bookmarks/${bookmark.id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || shouldRetainMutation(response.status)) {
        showNotice("Bookmark deletion will sync when you reconnect.");
        return;
      }
      await completeBookmarkDelete(queued);
      if (!response.ok && response.status !== 404) {
        setBookmarks((current) => sortByPosition([...current, bookmark]));
        await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark });
        broadcastBookmarkReconciliation({ userId, bookId }, { kind: "upsert", bookmark });
      } else {
        broadcastBookmarkReconciliation(
          { userId, bookId },
          { kind: "delete", bookmarkId: bookmark.id },
        );
      }
    },
    [bookId, showNotice, userId],
  );

  const saveBookmarkNote = useCallback(
    async (bookmark: Bookmark, note: string | null) => {
      if (bookmark.id.startsWith(PENDING_PREFIX)) {
        const updated = { ...bookmark, note };
        await withBookmarkMutationLock(userId, bookId, bookmark.id, async () => {
          const queued = await updateQueuedBookmarkNote(
            userId,
            bookmark.id.slice(PENDING_PREFIX.length),
            note,
          );
          if (!queued) return;
          setBookmarks((current) =>
            current.map((item) => (item.id === bookmark.id ? updated : item)),
          );
          await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark: updated });
        });
        return;
      }
      await withBookmarkMutationLock(userId, bookId, bookmark.id, async () => {
        const entry = await queueBookmarkUpdate({
          userId,
          bookId,
          bookmarkId: bookmark.id,
          note,
          previousNote: bookmark.note,
        });
        if (entry.revision === 0) return;
        setBookmarks((current) =>
          current.map((item) => (item.id === bookmark.id ? { ...item, note } : item)),
        );
        await projectOfflineBookmark(userId, bookId, {
          kind: "upsert",
          bookmark: { ...bookmark, note },
        });
        const response = await fetch(`/api/books/${bookId}/bookmarks/${bookmark.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        }).catch(() => null);
        if (!response || shouldRetainMutation(response.status)) {
          showNotice("The note will sync when you reconnect.");
          return;
        }
        const payload = response.ok ? await readJson(response.clone(), isBookmarkPayload) : null;
        const mayRollback = await completeBookmarkUpdate(entry);
        if (payload) {
          setBookmarks((current) =>
            current.map((item) => (item.id === bookmark.id ? payload.bookmark : item)),
          );
          await projectOfflineBookmark(userId, bookId, {
            kind: "upsert",
            bookmark: payload.bookmark,
          });
          broadcastBookmarkReconciliation(
            { userId, bookId },
            { kind: "upsert", bookmark: payload.bookmark },
          );
        } else if (response.status === 404 && mayRollback) {
          setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
          await projectOfflineBookmark(userId, bookId, {
            kind: "delete",
            bookmarkId: bookmark.id,
          });
          broadcastBookmarkReconciliation(
            { userId, bookId },
            { kind: "delete", bookmarkId: bookmark.id },
          );
          showNotice("That bookmark was deleted on another device.");
        } else if (!response.ok && mayRollback) {
          setBookmarks((current) =>
            current.map((item) =>
              item.id === bookmark.id ? { ...item, note: bookmark.note } : item,
            ),
          );
          await projectOfflineBookmark(userId, bookId, { kind: "upsert", bookmark });
          broadcastBookmarkReconciliation(
            { userId, bookId },
            { kind: "note", bookmarkId: bookmark.id, note: bookmark.note },
          );
          showNotice("The note needs a connection to save.");
        }
      });
    },
    [bookId, showNotice, userId],
  );

  return { bookmarks, notice, addBookmark, deleteBookmark, saveBookmarkNote };
}

export function isPendingBookmark(bookmark: Bookmark): boolean {
  return bookmark.id.startsWith(PENDING_PREFIX);
}

function pendingId(clientId: string): string {
  return `${PENDING_PREFIX}${clientId}`;
}

function asPendingBookmark(entry: QueuedBookmark): Bookmark {
  return {
    id: pendingId(entry.clientId),
    positionMs: entry.positionMs,
    note: entry.note,
    createdAt: entry.createdAt,
  };
}

function sortByPosition(items: Bookmark[]): Bookmark[] {
  return [...items].sort((left, right) => left.positionMs - right.positionMs);
}

type BookmarkRejectedDetail = {
  userId: string;
  bookId: string;
  bookmarkId: string;
};

type BookmarkReconciliationDetail = {
  userId: string;
  bookId: string;
  bookmarkId: string;
} & (
  | { kind: "delete" }
  | { kind: "note"; note: string | null }
  | { kind: "upsert"; bookmark: Bookmark; pendingId?: string }
);
