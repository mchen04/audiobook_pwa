"use client";

import { useCallback, useEffect, useState } from "react";

import type { LibraryBook } from "@/domain/library";
import { afterLaunchPaint } from "@/lib/launch-revalidation";
import { database, mirrorKeyTail, type OfflineBook } from "@/lib/offline/db";
import { removeOfflineBook } from "@/lib/offline/deletion-journal";
import { listOfflineBooks, listStoredOfflineBooks } from "@/lib/offline/library";
import {
  applyPullBatch,
  getMirrorContinueBook,
  getSyncMeta,
  listMirrorBooks,
  listMirrorTagNames,
} from "@/lib/offline/mirror";
import { isPullBatch } from "@/lib/offline/sync-protocol";

import type { SortOrder, StatusFilter } from "./library-view";

/**
 * The library's only source of truth is this device.
 *
 * Every read below goes to IndexedDB — the mirror for metadata, `downloads`
 * for the audio this device actually holds. There is no "am I online?" branch
 * on this path, which is what makes search, the facets, sort and the continue
 * card behave identically with the network off.
 *
 * The network appears exactly once, *after* the first paint, as revalidation:
 * a pull is applied to the mirror and the re-read patches into the list that
 * is already on screen.
 */

export type LibraryFilters = {
  query: string;
  status: StatusFilter;
  tag: string | null;
  sort: SortOrder;
  onDevice: boolean;
};

/** Downloads keyed by book id: byte size, cover art, and the record to play. */
export type DeviceIndex = Map<string, OfflineBook>;

export type LibraryListing = {
  /** Matching rows, already filtered and sorted. */
  books: LibraryBook[];
  /** Every book on this device, regardless of the active filters. */
  device: DeviceIndex;
  /** Every book this account has anywhere, for the empty-library decision. */
  libraryTotal: number;
  tags: string[];
  continueBook: LibraryBook | null;
};

type Overview = { libraryTotal: number; tags: string[]; continueBook: LibraryBook | null };
type Listing = { books: LibraryBook[]; device: DeviceIndex };

const PULL_PAGE_LIMIT = 50;

/**
 * How long a device that has never synced may spend on its first pull before
 * the library gives up waiting and shows what it has.
 *
 * Without a ceiling a stalled-but-alive connection would hold a first-time user
 * on "setting up" indefinitely — the same failure the service worker's
 * navigation budget exists to prevent.
 */
const FIRST_SYNC_GATE_MS = 4_000;

/** Whether this device has ever completed a pull for the signed-in account. */
type FirstSync = "unknown" | "pending" | "done";

export function useLibraryBooks(userId: string | null, filters: LibraryFilters) {
  const { query, status, tag, sort, onDevice } = filters;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [firstSync, setFirstSync] = useState<FirstSync>("unknown");

  const reread = useCallback(() => setNonce((current) => current + 1), []);

  // Filter-independent: the tag vocabulary, the continue card and the total
  // the readiness marker is decided from. Keystrokes never re-read these.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void readOverview(userId)
      .then((next) => {
        if (active) setOverview(next);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [userId, nonce]);

  // The list itself. The previous list stays mounted while this runs, so a
  // re-read patches rows in place instead of unmounting the grid.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void readListing(userId, { query, status, tag, sort, onDevice })
      .then((next) => {
        if (active) setListing(next);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [userId, query, status, tag, sort, onDevice, nonce]);

  // Revalidation, after paint and never before.
  //
  // An earlier version scheduled this on `requestAnimationFrame` from mount,
  // which fires while the mirror is still being read — before there is any
  // paint to be "after". `afterLaunchPaint` waits for the render that puts the
  // user's real library on screen and then for the browser to go quiet, so the
  // pull competes with nothing that launch is measured on.
  //
  // The cold start is the exception, and it is the one section 10 asks for: a
  // device that has never completed a pull has no mirror to paint, so it would
  // be telling someone with a library that they have no books. There is nothing
  // to protect, so the first pull runs at once and the library waits for it.
  // The test is the sync cursor, not "the list looks empty" — an account that
  // genuinely owns no books has a cursor, and must not re-pull eagerly on every
  // launch forever.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let cancelWait = () => {};
    let gate = 0;
    const settleFirstSync = () => {
      window.clearTimeout(gate);
      if (active) setFirstSync("done");
    };
    const run = () => {
      void revalidate(userId).then((outcome) => {
        settleFirstSync();
        if (!active) return;
        // An expired or revoked session must never strand the user on a
        // cached library. Purging belongs to the sign-in/sign-out path,
        // which owns it; doing it here would destroy the only copy of the
        // audio over a session that has merely timed out.
        if (outcome === "unauthorized") {
          window.location.replace("/login");
          return;
        }
        reread();
      });
    };
    void getSyncMeta(userId)
      .catch(() => undefined)
      .then((meta) => {
        if (!active) return;
        if (meta?.cursor) {
          setFirstSync("done");
          cancelWait = afterLaunchPaint(run);
          return;
        }
        setFirstSync("pending");
        gate = window.setTimeout(settleFirstSync, FIRST_SYNC_GATE_MS);
        run();
      });
    return () => {
      active = false;
      window.clearTimeout(gate);
      cancelWait();
    };
  }, [userId, reconnects, reread]);

  // Section 6: pull runs on launch and on reconnect. Nothing else listens for
  // connectivity, and nothing on the read path does.
  useEffect(() => {
    const onOnline = () => setReconnects((current) => current + 1);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const retry = useCallback(() => {
    setUnavailable(false);
    reread();
  }, [reread]);

  /** After an import: pull it back down, then re-read. */
  const reload = useCallback(async () => {
    if (!userId) return;
    await revalidate(userId);
    reread();
  }, [userId, reread]);

  const removeDownload = useCallback(
    async (bookId: string) => {
      if (!userId) return false;
      try {
        // Journaled before any bytes move, so a failure retries on next load.
        // This removes the media this device holds and nothing else: the book,
        // its chapters, tags, progress and history are untouched.
        await removeOfflineBook(userId, bookId);
      } catch {
        return false;
      }
      reread();
      return true;
    },
    [userId, reread],
  );

  const snapshot: LibraryListing | null = overview && listing ? { ...listing, ...overview } : null;

  return {
    snapshot,
    /**
     * This device has never completed a pull for this account, so an empty
     * mirror does not mean an empty library — it means nobody has asked yet.
     * The caller must not present that as the genuine "no books" state.
     */
    preparing: firstSync !== "done",
    unavailable,
    reload,
    retry,
    removeDownload,
  };
}

// ---------------------------------------------------------------------------
// Local reads
// ---------------------------------------------------------------------------

async function readOverview(userId: string): Promise<Overview> {
  const [tags, continueBook, mirrorIds, records] = await Promise.all([
    listMirrorTagNames(userId),
    getMirrorContinueBook(userId),
    readMirrorBookIds(userId),
    listStoredOfflineBooks(userId),
  ]);
  const deviceOnly = records.filter((record) => !mirrorIds.has(record.book.id)).length;
  return { libraryTotal: mirrorIds.size + deviceOnly, tags, continueBook };
}

async function readListing(userId: string, filters: LibraryFilters): Promise<Listing> {
  const [rows, records, mirrorIds] = await Promise.all([
    listMirrorBooks(userId, {
      query: filters.query.trim() || undefined,
      status: filters.status,
      tag: filters.tag || undefined,
      sort: filters.sort,
    }),
    listStoredOfflineBooks(userId),
    readMirrorBookIds(userId),
  ]);
  const device: DeviceIndex = new Map(records.map((record) => [record.book.id, record]));
  const merged = withDeviceOnlyBooks(rows, records, mirrorIds, filters);
  return { books: filters.onDevice ? merged.filter((row) => device.has(row.id)) : merged, device };
}

/** Ids only — no record is deserialized, so this stays cheap on big libraries. */
async function readMirrorBookIds(userId: string): Promise<Set<string>> {
  const db = await database();
  const keys = await db.getAllKeysFromIndex("books", "by-user", userId);
  return new Set(keys.map(mirrorKeyTail));
}

/**
 * A book can be on this device before it exists in the mirror: a local import
 * lands in `downloads` at once, and the first pull after an upgrade or after
 * the mirror was evicted has not run yet (design contract sections 10 and 12).
 * Those records are projected into rows and filtered by the same rules rather
 * than dropped, so the library never hides a book this device can play.
 */
function withDeviceOnlyBooks(
  rows: LibraryBook[],
  records: OfflineBook[],
  mirrorIds: Set<string>,
  filters: LibraryFilters,
): LibraryBook[] {
  const extras = records
    .filter((record) => !mirrorIds.has(record.book.id))
    .map(asLibraryBook)
    .filter((row) => matchesDeviceOnly(row, filters));
  if (!extras.length) return rows;
  return [...rows, ...extras].sort(comparatorFor(filters.sort));
}

function asLibraryBook(record: OfflineBook): LibraryBook {
  return {
    id: record.book.id,
    title: record.book.title,
    author: record.book.author,
    narrator: null,
    series: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: record.downloadedAt,
    updatedAt: record.downloadedAt,
    tags: [],
    durationMs: record.book.durationMs,
    positionMs: record.book.initialPositionMs || 0,
    completed: record.book.completed || false,
    progressUpdatedAt: record.book.initialProgressOccurredAt,
  };
}

/** The mirror's own rules, applied to a row the mirror does not hold yet. */
function matchesDeviceOnly(row: LibraryBook, filters: LibraryFilters): boolean {
  // A row the mirror has never seen carries no tag edges, so any tag facet
  // excludes it rather than silently widening the filter.
  if (filters.tag) return false;
  const completed = row.completed || false;
  const positionMs = row.positionMs || 0;
  if (filters.status === "archived") return false;
  if (filters.status === "finished" && !completed) return false;
  if (filters.status === "in-progress" && (completed || positionMs === 0)) return false;
  if (filters.status === "not-started" && (completed || positionMs > 0)) return false;
  const needle = filters.query.trim().toLowerCase();
  return !needle || `${row.title} ${row.author}`.toLowerCase().includes(needle);
}

/**
 * Mirrors `comparatorFor` in `lib/offline/mirror.ts`. It is needed only to
 * splice device-only rows into an already-sorted list; the mirror stays the
 * single implementation for everything it holds.
 */
function comparatorFor(sort: SortOrder): (left: LibraryBook, right: LibraryBook) => number {
  if (sort === "title" || sort === "author") {
    return (left, right) =>
      left[sort].toLowerCase().localeCompare(right[sort].toLowerCase()) ||
      left.id.localeCompare(right.id);
  }
  if (sort === "added") {
    return (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  }
  return (left, right) =>
    activityAt(right).localeCompare(activityAt(left)) || right.id.localeCompare(left.id);
}

function activityAt(book: LibraryBook): string {
  return book.progressUpdatedAt && book.progressUpdatedAt > book.updatedAt
    ? book.progressUpdatedAt
    : book.updatedAt;
}

// ---------------------------------------------------------------------------
// Revalidation — the only network on this path, and only after paint
// ---------------------------------------------------------------------------

type PullOutcome = "applied" | "unauthorized" | "unreachable";

async function revalidate(userId: string): Promise<PullOutcome> {
  const outcome = await pull(userId);
  // Reconciling downloads against Cache Storage is how evicted audio is
  // detected: the stale record is dropped, and the book keeps its metadata and
  // is marked "not on this device" instead of continuing to look playable.
  await listOfflineBooks(userId).catch(() => undefined);
  return outcome;
}

async function pull(userId: string): Promise<PullOutcome> {
  // Bounded: a server that keeps reporting `complete: false` without advancing
  // its cursor must not spin here.
  for (let page = 0; page < PULL_PAGE_LIMIT; page += 1) {
    const meta = await getSyncMeta(userId).catch(() => undefined);
    const since = meta?.cursor ? `?since=${encodeURIComponent(meta.cursor)}` : "";
    let response: Response;
    try {
      response = await fetch(`/api/sync/pull${since}`, { cache: "no-store" });
    } catch {
      return "unreachable";
    }
    if (response.status === 401 || response.status === 403) return "unauthorized";
    if (!response.ok) return "unreachable";
    const batch: unknown = await response.json().catch(() => null);
    if (!isPullBatch(batch)) return "unreachable";
    try {
      await applyPullBatch(userId, batch);
    } catch {
      // The batch is all-or-nothing and the cursor moves with it, so a failed
      // apply leaves the mirror exactly as it was and the next pull retries.
      return "unreachable";
    }
    if (batch.complete) return "applied";
  }
  return "applied";
}
