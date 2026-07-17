import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { PLAYBACK_HISTORY_LIMIT } from "@/domain/playback-history";
import { db } from "@/server/db/client";
import {
  books,
  bookTags,
  chapters,
  collectionBooks,
  collections,
  listeningSessions,
  mediaAssets,
  playbackStates,
  playbackActions,
  tags,
} from "@/server/db/schema";
import { playbackHistoryLockKey } from "@/server/playback/lock-key";

import {
  decodeLibraryCursor,
  encodeLibraryCursor,
  type LibraryCursor,
  type LibrarySort,
} from "./library-cursor";

export type LibraryQuery = {
  query?: string;
  status?: "all" | "in-progress" | "not-started" | "finished" | "archived";
  tag?: string;
  sort?: LibrarySort;
  cursor?: string;
  limit?: number;
};

const librarySelection = {
  id: books.id,
  title: books.title,
  author: books.author,
  narrator: books.narrator,
  series: books.series,
  chapterDiagnostic: books.chapterDiagnostic,
  archivedAt: books.archivedAt,
  createdAt: books.createdAt,
  updatedAt: books.updatedAt,
  durationMs: mediaAssets.durationMs,
  positionMs: playbackStates.positionMs,
  completed: playbackStates.completed,
  progressUpdatedAt: playbackStates.updatedAt,
};

/** Stable keyset pagination keeps database, response, hydration, and DOM work bounded. */
export async function listBooksPage(userId: string, input: LibraryQuery = {}) {
  const limit = Math.min(100, Math.max(1, input.limit || 50));
  const status = input.status || "all";
  const sort = input.sort || "activity";
  const conditions: SQL[] = [eq(books.ownerId, userId), statusCondition(status)];
  const normalizedQuery = input.query?.trim().toLowerCase();
  if (normalizedQuery) {
    const pattern = `%${normalizedQuery}%`;
    conditions.push(sql`(
      lower(coalesce(${books.title}, '') || ' ' || coalesce(${books.author}, '') || ' ' || coalesce(${books.narrator}, '') || ' ' || coalesce(${books.series}, '')) like ${pattern}
      or exists (
        select 1 from ${bookTags}
        join ${tags} on ${tags.id} = ${bookTags.tagId}
        where ${bookTags.bookId} = ${books.id} and lower(${tags.name}) like ${pattern}
      )
    )`);
  }
  if (input.tag) {
    conditions.push(sql`exists (
      select 1 from ${bookTags}
      join ${tags} on ${tags.id} = ${bookTags.tagId}
      where ${bookTags.bookId} = ${books.id} and ${tags.name} = ${input.tag}
    )`);
  }
  const cursor = decodeLibraryCursor(input.cursor, sort);
  const sortExpression = librarySortExpression(sort);
  if (cursor) conditions.push(cursorCondition(sort, sortExpression, cursor));

  const rows = await db
    .select(librarySelection)
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .leftJoin(
      playbackStates,
      and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(
      sort === "title" || sort === "author" ? asc(sortExpression) : desc(sortExpression),
      sort === "title" || sort === "author" ? asc(books.id) : desc(books.id),
    )
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeLibraryCursor({
          version: 1,
          sort,
          value: libraryCursorValue(sort, last),
          id: last.id,
        })
      : null;

  // The matching total is identical across cursor pages of one filter, so
  // only the first page pays the count; later pages return null (unchanged).
  if (cursor) return { books: await withBookTags(pageRows), nextCursor, total: null };

  const [taggedBooks, [total]] = await Promise.all([
    withBookTags(pageRows),
    db
      .select({ value: count() })
      .from(books)
      .leftJoin(
        playbackStates,
        and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
      )
      .where(and(...conditions)),
  ]);
  return { books: taggedBooks, nextCursor, total: total?.value || 0 };
}

/** The filter-independent library shell: totals, tag chips, and the continue card. */
export async function getLibraryOverview(userId: string) {
  const [[libraryTotal], tagRows, [continueBook]] = await Promise.all([
    db.select({ value: count() }).from(books).where(eq(books.ownerId, userId)),
    db
      .select({ name: tags.name })
      .from(tags)
      .where(eq(tags.userId, userId))
      .orderBy(asc(tags.name))
      .limit(100),
    db
      // A correlated tag aggregate is the right tool for this single-row
      // query; page rows use the batched withBookTags instead.
      .select({
        ...librarySelection,
        tags: sql<string[]>`coalesce((
          select json_agg(${tags.name} order by ${tags.name})
          from ${bookTags}
          join ${tags} on ${tags.id} = ${bookTags.tagId}
          where ${bookTags.bookId} = ${books.id}
        ), '[]'::json)`,
      })
      .from(books)
      .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
      .leftJoin(
        playbackStates,
        and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
      )
      .where(
        and(
          eq(books.ownerId, userId),
          sql`${books.archivedAt} is null`,
          sql`coalesce(${playbackStates.completed}, false) = false`,
          sql`coalesce(${playbackStates.positionMs}, 0) > 0`,
        ),
      )
      .orderBy(desc(playbackStates.updatedAt), desc(books.id))
      .limit(1),
  ]);

  return {
    libraryTotal: libraryTotal?.value || 0,
    tags: tagRows.map((tag) => tag.name),
    continueBook: continueBook || null,
  };
}

/** One indexed batch fetch instead of a correlated tags subquery per row. */
async function withBookTags<T extends { id: string }>(
  rows: T[],
): Promise<Array<T & { tags: string[] }>> {
  if (!rows.length) return [];
  const tagRows = await db
    .select({ bookId: bookTags.bookId, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(
      inArray(
        bookTags.bookId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(tags.name));
  const byBook = new Map<string, string[]>();
  for (const tag of tagRows) {
    const names = byBook.get(tag.bookId) || [];
    names.push(tag.name);
    byBook.set(tag.bookId, names);
  }
  return rows.map((row) => ({ ...row, tags: byBook.get(row.id) || [] }));
}

function statusCondition(status: NonNullable<LibraryQuery["status"]>): SQL {
  if (status === "archived") return sql`${books.archivedAt} is not null`;
  if (status === "finished") {
    return sql`${books.archivedAt} is null and coalesce(${playbackStates.completed}, false) = true`;
  }
  if (status === "in-progress") {
    return sql`${books.archivedAt} is null and coalesce(${playbackStates.completed}, false) = false and coalesce(${playbackStates.positionMs}, 0) > 0`;
  }
  if (status === "not-started") {
    return sql`${books.archivedAt} is null and coalesce(${playbackStates.completed}, false) = false and coalesce(${playbackStates.positionMs}, 0) = 0`;
  }
  return sql`${books.archivedAt} is null`;
}

function librarySortExpression(sort: NonNullable<LibraryQuery["sort"]>): SQL {
  if (sort === "title") return sql`lower(${books.title})`;
  if (sort === "author") return sql`lower(${books.author})`;
  if (sort === "added") return sql`${books.createdAt}`;
  // Activity = the later of the last metadata edit and the last listen;
  // greatest() skips nulls, so books never played sort by their edits. The
  // expression is not indexable, which is the deliberate trade: per-user
  // libraries sort a few hundred rows in memory, while a denormalized
  // activity column would put index write-amplification back on the 15s
  // progress heartbeat. Revisit only if libraries reach many thousands.
  return sql`greatest(${books.updatedAt}, ${playbackStates.updatedAt})`;
}

function cursorCondition(
  sort: NonNullable<LibraryQuery["sort"]>,
  expression: SQL,
  cursor: LibraryCursor,
): SQL {
  if (sort === "title" || sort === "author") {
    return sql`(${expression}, ${books.id}) > (${cursor.value}, ${cursor.id}::uuid)`;
  }
  return sql`(${expression}, ${books.id}) < (${cursor.value}::timestamptz, ${cursor.id}::uuid)`;
}

function libraryCursorValue(
  sort: NonNullable<LibraryQuery["sort"]>,
  row: {
    title: string;
    author: string;
    createdAt: Date;
    updatedAt: Date;
    progressUpdatedAt: Date | null;
  },
): string {
  if (sort === "title") return String(row.title).toLowerCase();
  if (sort === "author") return String(row.author).toLowerCase();
  if (sort === "added") return (row.createdAt as Date).toISOString();
  const activityAt =
    row.progressUpdatedAt && row.progressUpdatedAt > row.updatedAt
      ? row.progressUpdatedAt
      : row.updatedAt;
  return activityAt.toISOString();
}

export async function getBookForUser(userId: string, bookId: string) {
  const [book] = await db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      narrator: books.narrator,
      description: books.description,
      series: books.series,
      seriesPosition: books.seriesPosition,
      archivedAt: books.archivedAt,
      chapterDiagnostic: books.chapterDiagnostic,
      byteSize: mediaAssets.byteSize,
      durationMs: mediaAssets.durationMs,
      mimeType: mediaAssets.mimeType,
      mediaFingerprint: mediaAssets.fingerprint,
      mediaFingerprintKind: mediaAssets.fingerprintKind,
      positionMs: playbackStates.positionMs,
      playbackRate: playbackStates.playbackRate,
      completed: playbackStates.completed,
      progressUpdatedAt: playbackStates.updatedAt,
      progressOccurredAt: playbackStates.eventOccurredAt,
    })
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .leftJoin(
      playbackStates,
      and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
    )
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .limit(1);

  if (!book) return null;
  const [chapterRows, tagRows] = await Promise.all([
    db.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(chapters.position),
    db
      .select({ name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, bookId))
      .orderBy(asc(tags.name)),
  ]);

  return { ...book, chapters: chapterRows, tags: tagRows.map((tag) => tag.name) };
}

/**
 * The next unfinished book after this one inside the first ordered collection
 * that contains it, used for optional continuous series play.
 */
export async function getNextBookInCollection(userId: string, bookId: string) {
  const [membership] = await db
    .select({ collectionId: collectionBooks.collectionId, position: collectionBooks.position })
    .from(collectionBooks)
    .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
    .where(and(eq(collectionBooks.bookId, bookId), eq(collections.userId, userId)))
    .orderBy(asc(collectionBooks.position))
    .limit(1);
  if (!membership) return null;

  const [next] = await db
    .select({ id: books.id, title: books.title, collectionName: collections.name })
    .from(collectionBooks)
    .innerJoin(books, eq(books.id, collectionBooks.bookId))
    .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
    .leftJoin(
      playbackStates,
      and(eq(playbackStates.bookId, books.id), eq(playbackStates.userId, userId)),
    )
    .where(
      and(
        eq(collectionBooks.collectionId, membership.collectionId),
        sql`${collectionBooks.position} > ${membership.position}`,
        eq(books.ownerId, userId),
        sql`${books.archivedAt} is null`,
        sql`coalesce(${playbackStates.completed}, false) = false`,
      ),
    )
    .orderBy(asc(collectionBooks.position))
    .limit(1);
  return next || null;
}

export async function listRecentSessionsForBook(userId: string, bookId: string, limit = 5) {
  return db
    .select({
      id: listeningSessions.id,
      startedAt: listeningSessions.startedAt,
      endedAt: listeningSessions.endedAt,
      startPositionMs: listeningSessions.startPositionMs,
      endPositionMs: listeningSessions.endPositionMs,
      listenedMs: listeningSessions.listenedMs,
    })
    .from(listeningSessions)
    .where(and(eq(listeningSessions.userId, userId), eq(listeningSessions.bookId, bookId)))
    .orderBy(desc(listeningSessions.startedAt))
    .limit(limit);
}

/** The single row an INSERT/UPDATE ... RETURNING must produce. */
export function expectRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error("Expected a returned row.");
  return row;
}

/** Canonical ownership lookup for book mutations. Null when not owned. */
export async function getOwnedBook(userId: string, bookId: string) {
  const [owned] = await db
    .select({
      id: books.id,
      durationMs: mediaAssets.durationMs,
    })
    .from(books)
    .leftJoin(mediaAssets, eq(mediaAssets.bookId, books.id))
    .where(and(eq(books.id, bookId), eq(books.ownerId, userId)))
    .limit(1);
  return owned || null;
}

export async function getPlaybackHistorySnapshotForBook(
  userId: string,
  bookId: string,
  limit = PLAYBACK_HISTORY_LIMIT,
) {
  // The advisory lock is load-bearing: writers assign recordedAt under the
  // same key, so a read holding it can never miss an entry with
  // recordedAt <= capturedAt. Reading the clock in the lock statement —
  // possibly before the wait — only under-claims the boundary, which is safe.
  return db.transaction(async (transaction) => {
    const [boundary] = await transaction.execute<{ capturedAt: string }>(
      sql`select pg_advisory_xact_lock(hashtextextended(${playbackHistoryLockKey(userId, bookId)}, 0)), clock_timestamp() as "capturedAt"`,
    );
    const rows = await transaction
      .select({
        id: playbackActions.id,
        action: playbackActions.action,
        positionMs: playbackActions.positionMs,
        previousPositionMs: playbackActions.previousPositionMs,
        playbackRate: playbackActions.playbackRate,
        description: playbackActions.description,
        occurredAt: playbackActions.occurredAt,
        recordedAt: playbackActions.recordedAt,
      })
      .from(playbackActions)
      .where(and(eq(playbackActions.userId, userId), eq(playbackActions.bookId, bookId)))
      .orderBy(desc(playbackActions.recordedAt), desc(playbackActions.id))
      .limit(Math.min(PLAYBACK_HISTORY_LIMIT, Math.max(1, limit)));
    return { rows, capturedAt: boundary!.capturedAt };
  });
}
