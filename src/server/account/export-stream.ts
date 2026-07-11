import { Readable } from "node:stream";

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import {
  bookmarks,
  books,
  bookTags,
  chapters,
  collectionBooks,
  collections,
  listeningSessions,
  mediaAssets,
  playbackStates,
  tags,
  userPreferences,
} from "@/server/db/schema";

import { AsyncChunkChannel } from "./async-chunk-channel";

const BOOK_BATCH_SIZE = 100;
const ROW_BATCH_SIZE = 500;
const encoder = new TextEncoder();

type ExportAccount = { id: string; email: string; name: string };
type Page<T, C> = { rows: T[]; cursor: C | null };
type PageLoader<T, C> = (cursor: C | null) => Promise<Page<T, C>>;

export function createAccountExportStream(account: ExportAccount): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    Readable.from(generateAccountExport(account)),
  ) as ReadableStream<Uint8Array>;
}

async function* generateAccountExport(account: ExportAccount) {
  const channel = new AsyncChunkChannel();
  const work = db
    .transaction(
      async (transaction) => {
        for await (const chunk of generateAccountSnapshot(account, transaction)) {
          await channel.push(chunk);
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    )
    .then(
      () => channel.close(),
      (error) => channel.fail(error),
    );
  let consumed = false;
  try {
    for await (const chunk of channel) yield chunk;
    consumed = true;
    await work;
  } finally {
    if (!consumed) {
      channel.cancel();
      await work.catch(() => undefined);
    }
  }
}

type ExportDatabase = Pick<typeof db, "select">;

async function* generateAccountSnapshot(account: ExportAccount, database: ExportDatabase) {
  const [preferences] = await database
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, account.id))
    .limit(1);
  yield encode(
    `{"format":"chapterline-export","version":2,"exportedAt":${JSON.stringify(new Date().toISOString())},"account":${JSON.stringify({ email: account.email, name: account.name })},"preferences":${JSON.stringify(preferences || null)},"books":`,
  );
  yield* jsonArray((cursor: BookCursor | null) => loadBookBatch(database, account.id, cursor));

  yield encode(',"progress":');
  yield* jsonArray(async (cursor: string | null) => {
    const rows = await database
      .select()
      .from(playbackStates)
      .where(
        and(
          eq(playbackStates.userId, account.id),
          ...(cursor ? [gt(playbackStates.bookId, cursor)] : []),
        ),
      )
      .orderBy(asc(playbackStates.bookId))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => row.bookId);
  });
  yield encode(',"bookmarks":');
  yield* jsonArray(async (cursor: string | null) => {
    const rows = await database
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, account.id), ...(cursor ? [gt(bookmarks.id, cursor)] : [])))
      .orderBy(asc(bookmarks.id))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => row.id);
  });
  yield encode(',"tags":');
  yield* jsonArray(async (cursor: string | null) => {
    const rows = await database
      .select()
      .from(tags)
      .where(and(eq(tags.userId, account.id), ...(cursor ? [gt(tags.id, cursor)] : [])))
      .orderBy(asc(tags.id))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => row.id);
  });
  yield encode(',"bookTags":');
  yield* jsonArray(async (cursor: { bookId: string; tagId: string } | null) => {
    const rows = await database
      .select({ bookId: bookTags.bookId, tagId: bookTags.tagId })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(
        and(
          eq(tags.userId, account.id),
          ...(cursor
            ? [
                sql`(${bookTags.bookId}, ${bookTags.tagId}) > (${cursor.bookId}::uuid, ${cursor.tagId}::uuid)`,
              ]
            : []),
        ),
      )
      .orderBy(asc(bookTags.bookId), asc(bookTags.tagId))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => ({ bookId: row.bookId, tagId: row.tagId }));
  });
  yield encode(',"collections":');
  yield* jsonArray(async (cursor: string | null) => {
    const rows = await database
      .select()
      .from(collections)
      .where(
        and(eq(collections.userId, account.id), ...(cursor ? [gt(collections.id, cursor)] : [])),
      )
      .orderBy(asc(collections.id))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => row.id);
  });
  yield encode(',"collectionBooks":');
  yield* jsonArray(
    async (cursor: { collectionId: string; position: number; bookId: string } | null) => {
      const rows = await database
        .select({
          collectionId: collectionBooks.collectionId,
          bookId: collectionBooks.bookId,
          position: collectionBooks.position,
        })
        .from(collectionBooks)
        .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
        .where(
          and(
            eq(collections.userId, account.id),
            ...(cursor
              ? [
                  sql`(${collectionBooks.collectionId}, ${collectionBooks.position}, ${collectionBooks.bookId}) > (${cursor.collectionId}::uuid, ${cursor.position}, ${cursor.bookId}::uuid)`,
                ]
              : []),
          ),
        )
        .orderBy(
          asc(collectionBooks.collectionId),
          asc(collectionBooks.position),
          asc(collectionBooks.bookId),
        )
        .limit(ROW_BATCH_SIZE);
      return keysetPage(rows, (row) => ({
        collectionId: row.collectionId,
        position: row.position,
        bookId: row.bookId,
      }));
    },
  );
  yield encode(',"listeningSessions":');
  yield* jsonArray(async (cursor: string | null) => {
    const rows = await database
      .select()
      .from(listeningSessions)
      .where(
        and(
          eq(listeningSessions.userId, account.id),
          ...(cursor ? [gt(listeningSessions.id, cursor)] : []),
        ),
      )
      .orderBy(asc(listeningSessions.id))
      .limit(ROW_BATCH_SIZE);
    return keysetPage(rows, (row) => row.id);
  });
  yield encode("}");
}

type BookCursor = { createdAt: string; id: string };

async function loadBookBatch(
  database: ExportDatabase,
  userId: string,
  cursor: BookCursor | null,
): Promise<Page<Awaited<ReturnType<typeof loadBookRows>>[number], BookCursor>> {
  const bookRows = await loadBookRows(database, userId, cursor);
  if (!bookRows.length) return { rows: [], cursor: null };

  const ids = bookRows.map((book) => book.id);
  const [mediaRows, chapterRows] = await Promise.all([
    database
      .select({
        bookId: mediaAssets.bookId,
        originalFilename: mediaAssets.originalFilename,
        byteSize: mediaAssets.byteSize,
        fingerprint: mediaAssets.fingerprint,
        fingerprintKind: mediaAssets.fingerprintKind,
        durationMs: mediaAssets.durationMs,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.bookId, ids)),
    database
      .select({
        bookId: chapters.bookId,
        position: chapters.position,
        title: chapters.title,
        startMs: chapters.startMs,
        endMs: chapters.endMs,
      })
      .from(chapters)
      .where(inArray(chapters.bookId, ids))
      .orderBy(asc(chapters.bookId), asc(chapters.position)),
  ]);
  const mediaByBook = new Map(mediaRows.map((media) => [media.bookId, media]));
  const chaptersByBook = new Map<string, typeof chapterRows>();
  for (const chapter of chapterRows) {
    const grouped = chaptersByBook.get(chapter.bookId);
    if (grouped) grouped.push(chapter);
    else chaptersByBook.set(chapter.bookId, [chapter]);
  }

  const rows = bookRows.map((book) => ({
    ...book,
    media: mediaByBook.get(book.id) || null,
    chapters: chaptersByBook.get(book.id) || [],
  }));
  const last = bookRows.at(-1)!;
  return {
    rows,
    cursor:
      bookRows.length === BOOK_BATCH_SIZE
        ? { createdAt: last.createdAt.toISOString(), id: last.id }
        : null,
  };
}

async function loadBookRows(database: ExportDatabase, userId: string, cursor: BookCursor | null) {
  const bookRows = await database
    .select()
    .from(books)
    .where(
      and(
        eq(books.ownerId, userId),
        ...(cursor
          ? [
              sql`(${books.createdAt}, ${books.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
            ]
          : []),
      ),
    )
    .orderBy(asc(books.createdAt), asc(books.id))
    .limit(BOOK_BATCH_SIZE);
  return bookRows;
}

async function* jsonArray<T, C>(loadPage: PageLoader<T, C>) {
  yield encode("[");
  let cursor: C | null = null;
  let first = true;
  while (true) {
    const page = await loadPage(cursor);
    const { rows } = page;
    for (const row of rows) {
      if (!first) yield encode(",");
      yield encode(JSON.stringify(row));
      first = false;
    }
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  yield encode("]");
}

function keysetPage<T, C>(rows: T[], cursorFor: (row: T) => C): Page<T, C> {
  const last = rows.at(-1);
  return {
    rows,
    cursor: rows.length === ROW_BATCH_SIZE && last ? cursorFor(last) : null,
  };
}

function encode(value: string) {
  return encoder.encode(value);
}
