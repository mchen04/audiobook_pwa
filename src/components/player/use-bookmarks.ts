"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Bookmark } from "@/domain/player";
import { formatClock } from "@/lib/format-time";
import {
  queueBookmark,
  queuedBookmarksFor,
  removeQueuedBookmark,
  updateQueuedBookmarkNote,
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
      .then(() => queuedBookmarksFor(userId, bookId).map(asPendingBookmark))
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

  const syncBookmark = useCallback(
    async (entry: QueuedBookmark) => {
      try {
        const response = await fetch(`/api/books/${bookId}/bookmarks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            positionMs: entry.positionMs,
            note: entry.note,
            clientId: entry.clientId,
          }),
        });
        const payload = await readJson(response, isBookmarkPayload);
        if (!payload) {
          deletedWhileSyncingRef.current.delete(entry.clientId);
          setBookmarks((current) =>
            current.filter((item) => item.id !== pendingId(entry.clientId)),
          );
          return;
        }
        if (deletedWhileSyncingRef.current.delete(entry.clientId)) {
          await fetch(`/api/books/${bookId}/bookmarks/${payload.bookmark.id}`, {
            method: "DELETE",
          }).catch(() => undefined);
          return;
        }
        setBookmarks((current) =>
          current.map((item) => (item.id === pendingId(entry.clientId) ? payload.bookmark : item)),
        );
      } catch {
        if (!deletedWhileSyncingRef.current.delete(entry.clientId)) {
          queueBookmark(entry);
        }
      }
    },
    [bookId],
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
      };
      setBookmarks((current) => sortByPosition([...current, asPendingBookmark(entry)]));
      showNotice(`Bookmark saved at ${formatClock(entry.positionMs)}.`);
      void syncBookmark(entry);
    },
    [bookId, showNotice, syncBookmark, userId],
  );

  const deleteBookmark = useCallback(
    async (bookmark: Bookmark) => {
      setBookmarks((current) => current.filter((item) => item.id !== bookmark.id));
      if (bookmark.id.startsWith(PENDING_PREFIX)) {
        const clientId = bookmark.id.slice(PENDING_PREFIX.length);
        deletedWhileSyncingRef.current.add(clientId);
        removeQueuedBookmark(userId, clientId);
        return;
      }
      const response = await fetch(`/api/books/${bookId}/bookmarks/${bookmark.id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) {
        setBookmarks((current) => sortByPosition([...current, bookmark]));
      }
    },
    [bookId, userId],
  );

  const saveBookmarkNote = useCallback(
    async (bookmark: Bookmark, note: string | null) => {
      setBookmarks((current) =>
        current.map((item) => (item.id === bookmark.id ? { ...item, note } : item)),
      );
      if (bookmark.id.startsWith(PENDING_PREFIX)) {
        updateQueuedBookmarkNote(userId, bookmark.id.slice(PENDING_PREFIX.length), note);
        return;
      }
      const response = await fetch(`/api/books/${bookId}/bookmarks/${bookmark.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      }).catch(() => null);
      if (!response?.ok) {
        setBookmarks((current) =>
          current.map((item) =>
            item.id === bookmark.id ? { ...item, note: bookmark.note } : item,
          ),
        );
        showNotice("The note needs a connection to save.");
      }
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
