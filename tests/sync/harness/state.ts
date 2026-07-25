import type { Page } from "@playwright/test";

import { mirror, sql } from "./app";
import type { MirrorSnapshot } from "./driver-entry";
import type { DeviceState, ServerState } from "./model";

/**
 * The two observations the oracle is checked against.
 *
 * `readServerState` goes to Postgres over SQL from the test process — a
 * completely separate path from anything the app writes locally, and the only
 * evidence that a write left the device. `readDeviceState` reads the mirror
 * the app will paint from on its next launch.
 *
 * Both are keyed by the media FINGERPRINT rather than by book id, because the
 * fingerprint is the identity the TEST chose before the server assigned a uuid.
 * Keying on the server's id would quietly make the comparison circular.
 */

export async function readServerState(userId: string): Promise<ServerState> {
  const client = sql();
  const [bookRows, tagRows, collectionRows, progressRows, historyRows] = await Promise.all([
    client<
      {
        book_id: string;
        title: string;
        author: string;
        archived_at: Date | null;
        fingerprint: string;
        chapter_count: number;
      }[]
    >`
      SELECT b.id AS book_id, b.title, b.author, b.archived_at, m.fingerprint,
             (SELECT count(*) FROM chapters c WHERE c.book_id = b.id)::int AS chapter_count
      FROM books b
      JOIN media_assets m ON m.book_id = b.id
      WHERE b.owner_id = ${userId}
    `,
    client<{ fingerprint: string; name: string }[]>`
      SELECT m.fingerprint, t.name
      FROM book_tags bt
      JOIN tags t ON t.id = bt.tag_id
      JOIN media_assets m ON m.book_id = bt.book_id
      WHERE t.user_id = ${userId}
    `,
    client<{ name: string; fingerprint: string }[]>`
      SELECT c.name, m.fingerprint
      FROM collection_books cb
      JOIN collections c ON c.id = cb.collection_id
      JOIN media_assets m ON m.book_id = cb.book_id
      WHERE c.user_id = ${userId}
    `,
    client<{ fingerprint: string; position_ms: string; completed: boolean }[]>`
      SELECT m.fingerprint, ps.position_ms, ps.completed
      FROM playback_states ps
      JOIN media_assets m ON m.book_id = ps.book_id
      WHERE ps.user_id = ${userId}
    `,
    client<{ id: string }[]>`
      SELECT id FROM playback_actions WHERE user_id = ${userId}
    `,
  ]);

  return {
    booksByFingerprint: new Map(
      bookRows.map((row) => [
        row.fingerprint,
        {
          bookId: row.book_id,
          title: row.title,
          author: row.author,
          archived: row.archived_at !== null,
          chapterCount: Number(row.chapter_count),
        },
      ]),
    ),
    tagsByFingerprint: groupSet(
      tagRows,
      (row) => row.fingerprint,
      (row) => row.name,
    ),
    collectionMembers: groupSet(
      collectionRows,
      (row) => row.name,
      (row) => row.fingerprint,
    ),
    progressByFingerprint: new Map(
      progressRows.map((row) => [
        row.fingerprint,
        { positionMs: Number(row.position_ms), completed: row.completed },
      ]),
    ),
    historyIds: new Set(historyRows.map((row) => row.id)),
  };
}

/** Every collection the account owns, by name — the id the driver needs to address it. */
export async function readCollectionIds(userId: string): Promise<Map<string, string>> {
  const rows = await sql()<{ id: string; name: string }[]>`
    SELECT id, name FROM collections WHERE user_id = ${userId}
  `;
  return new Map(rows.map((row) => [row.name, row.id]));
}

/** Every tag the account owns, by name. Read from Postgres, never from the mirror. */
export async function readTagIds(userId: string): Promise<Map<string, string>> {
  const rows = await sql()<{ id: string; name: string }[]>`
    SELECT id, name FROM tags WHERE user_id = ${userId}
  `;
  return new Map(rows.map((row) => [row.name, row.id]));
}

/** fingerprint → server book id, so the driver can address a book the server named. */
export async function readBookIds(userId: string): Promise<Map<string, string>> {
  const rows = await sql()<{ id: string; fingerprint: string }[]>`
    SELECT b.id, m.fingerprint
    FROM books b JOIN media_assets m ON m.book_id = b.id
    WHERE b.owner_id = ${userId}
  `;
  return new Map(rows.map((row) => [row.fingerprint, row.id]));
}

export function toDeviceState(snapshot: MirrorSnapshot): DeviceState {
  const tagNameById = new Map(snapshot.tags.map((tag) => [tag.tagId, tag.name]));
  const collectionNameById = new Map(
    snapshot.collections.map((collection) => [collection.collectionId, collection.name]),
  );
  const fingerprintByBookId = new Map(
    snapshot.books
      .filter((book) => book.media)
      .map((book) => [book.bookId, book.media!.fingerprint]),
  );

  const chapterCounts = new Map<string, number>();
  for (const chapter of snapshot.chapters) {
    chapterCounts.set(chapter.bookId, (chapterCounts.get(chapter.bookId) || 0) + 1);
  }

  const tagsByFingerprint = new Map<string, Set<string>>();
  for (const edge of snapshot.bookTags) {
    const fingerprint = fingerprintByBookId.get(edge.bookId);
    const name = tagNameById.get(edge.tagId);
    if (!fingerprint || !name) continue;
    const bucket = tagsByFingerprint.get(fingerprint);
    if (bucket) bucket.add(name);
    else tagsByFingerprint.set(fingerprint, new Set([name]));
  }

  const collectionMembers = new Map<string, Set<string>>();
  for (const collection of snapshot.collections) {
    collectionMembers.set(collection.name, new Set());
  }
  for (const member of snapshot.collectionBooks) {
    const name = collectionNameById.get(member.collectionId);
    const fingerprint = fingerprintByBookId.get(member.bookId);
    if (!name || !fingerprint) continue;
    collectionMembers.get(name)?.add(fingerprint);
  }

  const progressByFingerprint = new Map<string, { positionMs: number; completed: boolean }>();
  for (const state of snapshot.playbackStates) {
    const fingerprint = fingerprintByBookId.get(state.bookId);
    if (!fingerprint) continue;
    progressByFingerprint.set(fingerprint, {
      positionMs: state.positionMs,
      completed: state.completed,
    });
  }

  return {
    booksByFingerprint: new Map(
      snapshot.books
        .filter((book) => book.media)
        .map((book) => [
          book.media!.fingerprint,
          {
            bookId: book.bookId,
            title: book.title,
            author: book.author,
            archived: book.archivedAt !== null,
            chapterCount: chapterCounts.get(book.bookId) || 0,
          },
        ]),
    ),
    tagsByFingerprint,
    collectionMembers,
    progressByFingerprint,
  };
}

export async function readDeviceState(page: Page): Promise<DeviceState> {
  return toDeviceState(await mirror(page));
}

function groupSet<T>(
  rows: T[],
  keyOf: (row: T) => string,
  valueOf: (row: T) => string,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = grouped.get(key);
    if (bucket) bucket.add(valueOf(row));
    else grouped.set(key, new Set([valueOf(row)]));
  }
  return grouped;
}
