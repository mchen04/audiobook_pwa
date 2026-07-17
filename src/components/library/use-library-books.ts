"use client";

import { useEffect, useRef, useState } from "react";

import { isLibraryPage, readJson, type LibraryPage } from "@/lib/wire";

import type { SortOrder, StatusFilter } from "./library-view";

type LibraryOptions = {
  query: string;
  status: StatusFilter;
  tag: string | null;
  sort: SortOrder;
};

export function useLibraryBooks(initialPage: LibraryPage, options: LibraryOptions) {
  const { query, sort, status, tag } = options;
  const [page, setPage] = useState(initialPage);
  const [loading, setLoading] = useState(false);
  const firstRender = useRef(true);
  const generationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const firstPageAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = null;
    firstPageAbortRef.current?.abort();
    const controller = new AbortController();
    firstPageAbortRef.current = controller;
    setLoading(true);
    const timer = window.setTimeout(() => {
      // Only the matching total depends on the filter; tags, the library
      // total, and the continue card carry over from the initial page.
      void loadPartialPage({ query, sort, status, tag }, null, controller.signal)
        .then((next) => {
          if (generation === generationRef.current && firstPageAbortRef.current === controller) {
            setPage((current) => ({
              ...current,
              books: next.books,
              nextCursor: next.nextCursor,
              total: next.total ?? current.total,
            }));
          }
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
        })
        .finally(() => {
          if (generation === generationRef.current && firstPageAbortRef.current === controller) {
            firstPageAbortRef.current = null;
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, sort, status, tag]);

  async function reload(): Promise<void> {
    setPage(await loadPage({ query, sort, status, tag }));
  }

  async function loadMore(): Promise<void> {
    if (!page.nextCursor || loading) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = controller;
    setLoading(true);
    try {
      const next = await loadPartialPage(
        { query, sort, status, tag },
        page.nextCursor,
        controller.signal,
      );
      if (generation !== generationRef.current) return;
      setPage((current) => ({
        ...current,
        books: [...current.books, ...next.books],
        nextCursor: next.nextCursor,
        total: next.total ?? current.total,
      }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    } finally {
      if (paginationAbortRef.current === controller) {
        paginationAbortRef.current = null;
        setLoading(false);
      }
    }
  }

  return { page, reload, loadMore, loading };
}

async function loadPage(options: LibraryOptions, signal?: AbortSignal): Promise<LibraryPage> {
  const response = await fetch(`/api/books?${librarySearch(options)}`, {
    cache: "no-store",
    signal,
  });
  const payload = await readJson(response, isLibraryPage);
  if (!payload) throw new Error("The library could not be refreshed.");
  return payload;
}

/**
 * Filter reloads and cursor pages skip the filter-independent overview; the
 * total is null on cursor pages (unchanged from the filter's first page).
 */
async function loadPartialPage(
  options: LibraryOptions,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<{ books: LibraryPage["books"]; nextCursor: string | null; total: number | null }> {
  const search = librarySearch(options);
  if (cursor) search.set("cursor", cursor);
  search.set("meta", "0");
  const response = await fetch(`/api/books?${search}`, { cache: "no-store", signal });
  const payload = (await response.json().catch(() => null)) as {
    books?: LibraryPage["books"];
    nextCursor?: string | null;
    total?: number | null;
  } | null;
  if (
    !response.ok ||
    !payload?.books ||
    payload.nextCursor === undefined ||
    (cursor ? payload.total !== null : typeof payload.total !== "number")
  ) {
    throw new Error("The library could not be extended.");
  }
  return { books: payload.books, nextCursor: payload.nextCursor, total: payload.total ?? null };
}

function librarySearch(options: LibraryOptions): URLSearchParams {
  const search = new URLSearchParams({ status: options.status, sort: options.sort });
  if (options.query.trim()) search.set("query", options.query.trim());
  if (options.tag) search.set("tag", options.tag);
  return search;
}
