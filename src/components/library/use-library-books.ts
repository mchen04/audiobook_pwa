"use client";

import { useEffect, useRef, useState } from "react";

import type { LibraryBook } from "@/domain/library";
import { isLibraryPage, readJson } from "@/lib/wire";

/**
 * The client-side library list: renders instantly from the server page, then
 * streams remaining keyset pages in the background (starting after the page
 * settles so it never competes with first interaction). `reload` re-fetches
 * page one and restarts the stream — used after an import.
 */
export function useLibraryBooks(initialBooks: LibraryBook[], initialCursor: string | null) {
  const [books, setBooks] = useState(initialBooks);
  const [cursor, setCursor] = useState(initialCursor);
  const firstBackgroundLoadRef = useRef(true);

  useEffect(() => {
    if (!cursor) return;
    let active = true;
    const start = window.setTimeout(
      () => {
        void fetch(`/api/books?cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" })
          .then((response) => readJson(response, isLibraryPage))
          .then((payload) => {
            if (!active || !payload) return;
            setBooks((current) => {
              const known = new Set(current.map((book) => book.id));
              return [...current, ...payload.books.filter((book) => !known.has(book.id))];
            });
            setCursor(payload.nextCursor);
          })
          .catch(() => undefined);
      },
      firstBackgroundLoadRef.current ? 1_500 : 50,
    );
    firstBackgroundLoadRef.current = false;
    return () => {
      active = false;
      window.clearTimeout(start);
    };
  }, [cursor]);

  async function reload(): Promise<void> {
    const response = await fetch("/api/books", { cache: "no-store" });
    const payload = await readJson(response, isLibraryPage);
    if (!payload) throw new Error("The library could not be refreshed.");
    setBooks(payload.books);
    setCursor(payload.nextCursor);
  }

  return { books, loadingMore: cursor !== null, reload };
}
