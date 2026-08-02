import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { applyPullBatch, getMirrorContinueBook, listMirrorBooks } from "@/lib/offline/mirror";
import type { PullBatch, PulledBook, PulledPlaybackState } from "@/lib/offline/sync-protocol";
import { libraryCursorValue, librarySortsAscending } from "@/server/books/library-cursor";

/**
 * The library listing exists twice: `server/books/queries.ts` renders it in
 * SQL, and `lib/offline/mirror.ts` renders it from IndexedDB so the same list
 * appears with the network gone. This suite makes their agreement executable
 * instead of a comment.
 *
 * The mirror side runs for real (`listMirrorBooks` over fake IndexedDB). The
 * server's ordering runs for real too, through `libraryCursorValue` and
 * `librarySortsAscending` — the exact functions `listBooksPage` uses to build
 * keyset cursors and pick sort direction, so any drift between them and the
 * SQL sort expression already breaks pagination on its own. The parts that
 * live only in SQL (`statusCondition`, the search predicate) cannot execute
 * here; for those the oracle below transliterates the SQL clause by clause,
 * with coalesce defaults and the `|| ' ' ||` separators intact, so a change on
 * either side of the contract fails this file.
 */

const USER = "user-parity";

type Fixture = {
  book: PulledBook;
  state?: PulledPlaybackState;
};

function book(id: string, overrides: Partial<PulledBook> = {}): PulledBook {
  return {
    id,
    title: `Title ${id}`,
    author: "Author",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    media: {
      originalFilename: `${id}.mp3`,
      mimeType: "audio/mpeg",
      byteSize: 1_000_000,
      fingerprint: "f".repeat(64),
      fingerprintKind: "sha256-v1",
      durationMs: 3_600_000,
    },
    chapters: [{ position: 0, title: "Opening", startMs: 0, endMs: 3_600_000 }],
    tagIds: [],
    ...overrides,
  };
}

function state(
  bookId: string,
  positionMs: number,
  updatedAt: string,
  completed = false,
): PulledPlaybackState {
  return {
    bookId,
    positionMs,
    playbackRate: 1,
    completed,
    deviceId: "device-1",
    deviceSequence: 1,
    eventOccurredAt: updatedAt,
    updatedAt,
  };
}

/**
 * Every branch the two implementations disagree on when they drift: archived
 * rows, missing playback states (the SQL coalesce defaults), listens newer and
 * older than metadata edits, exact activity/title ties resolved by id, mixed
 * case, null narrator/series, and tag-only search matches.
 */
const FIXTURES: Fixture[] = [
  // Untouched, no playback state row at all; latest createdAt.
  {
    book: book("book-01", {
      title: "the zebra crossing",
      author: "Yates",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  },
  // In progress, listen newer than the metadata edit; tagged.
  {
    book: book("book-02", {
      title: "Apple Orchard",
      author: "brontë",
      series: "Seasons",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      tagIds: ["tag-scifi"],
    }),
    state: state("book-02", 500, "2026-07-10T00:00:00.000Z"),
  },
  // In progress, metadata edit newer than the listen (activity = updatedAt).
  {
    book: book("book-03", {
      title: "Middle March",
      author: "Ann",
      narrator: "Blake",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    }),
    state: state("book-03", 900, "2026-07-05T00:00:00.000Z"),
  },
  // Finished.
  {
    book: book("book-04", {
      title: "Quiet Ending",
      author: "Zola",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    }),
    state: state("book-04", 3_600_000, "2026-07-20T00:00:00.000Z", true),
  },
  // Archived, with progress that must not surface anywhere else.
  {
    book: book("book-05", {
      title: "Boxed Away",
      author: "Adams",
      archivedAt: "2026-07-15T00:00:00.000Z",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }),
    state: state("book-05", 700, "2026-07-14T00:00:00.000Z"),
  },
  // A playback state row at position 0: still not-started under coalesce.
  {
    book: book("book-06", {
      title: "Untouched But Opened",
      author: "Ann",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
      tagIds: ["tag-history"],
    }),
    state: state("book-06", 0, "2026-06-26T00:00:00.000Z"),
  },
  // Exact activity + title + author tie with book-08: only the id breaks it.
  {
    book: book("book-07", {
      title: "Duplicate",
      author: "Same",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    }),
  },
  {
    book: book("book-08", {
      title: "Duplicate",
      author: "Same",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    }),
  },
];

const TAGS = [
  { id: "tag-scifi", name: "Sci-Fi" },
  { id: "tag-history", name: "history" },
];

const TAG_NAMES_BY_BOOK = new Map(
  FIXTURES.map(({ book }) => [
    book.id,
    book.tagIds.map((tagId) => TAGS.find((tag) => tag.id === tagId)!.name),
  ]),
);

function batch(): PullBatch {
  return {
    since: null,
    cursor: "2026-07-30T00:00:00.000Z",
    complete: true,
    books: FIXTURES.map((fixture) => fixture.book),
    playbackStates: FIXTURES.flatMap((fixture) => (fixture.state ? [fixture.state] : [])),
    tags: TAGS,
    collections: [],
    preferences: null,
    listeningSessions: [],
    liveBookIds: null,
  };
}

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  await applyPullBatch(USER, batch());
});

type Sort = "activity" | "added" | "title" | "author";
type Status = "all" | "in-progress" | "not-started" | "finished" | "archived";

const SORTS: Sort[] = ["activity", "added", "title", "author"];
const STATUSES: Status[] = ["all", "in-progress", "not-started", "finished", "archived"];

/** `statusCondition` in `server/books/queries.ts`, clause for clause. */
function sqlStatusMatches(fixture: Fixture, status: Status): boolean {
  const archived = fixture.book.archivedAt !== null;
  const completed = fixture.state?.completed ?? false; // coalesce(completed, false)
  const positionMs = fixture.state?.positionMs ?? 0; // coalesce(position_ms, 0)
  if (status === "archived") return archived;
  if (status === "finished") return !archived && completed;
  if (status === "in-progress") return !archived && !completed && positionMs > 0;
  if (status === "not-started") return !archived && !completed && positionMs === 0;
  return !archived;
}

/** The search predicate in `listBooksPage`: concatenated text or a tag name. */
function sqlSearchMatches(fixture: Fixture, needle: string): boolean {
  const { title, author, narrator, series } = fixture.book;
  const haystack = [title, author, narrator ?? "", series ?? ""].join(" ").toLowerCase();
  if (haystack.includes(needle)) return true;
  return TAG_NAMES_BY_BOOK.get(fixture.book.id)!.some((tag) => tag.toLowerCase().includes(needle));
}

/** Orders ids exactly as the server's ORDER BY + keyset cursor does. */
function serverOrder(fixtures: Fixture[], sort: Sort): string[] {
  const ascending = librarySortsAscending(sort);
  const keyed = fixtures.map((fixture) => ({
    id: fixture.book.id,
    key: libraryCursorValue(sort, {
      title: fixture.book.title,
      author: fixture.book.author,
      createdAt: new Date(fixture.book.createdAt),
      updatedAt: new Date(fixture.book.updatedAt),
      progressUpdatedAt: fixture.state ? new Date(fixture.state.updatedAt) : null,
    }),
  }));
  keyed.sort((left, right) => {
    const byKey = left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    const byId = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    return (byKey || byId) * (ascending ? 1 : -1);
  });
  return keyed.map((row) => row.id);
}

describe("mirror listing vs server listing semantics", () => {
  it.each(SORTS)("orders the %s sort exactly as the server's cursor keys do", async (sort) => {
    const mirrorIds = (await listMirrorBooks(USER, { sort })).map((row) => row.id);
    const visible = FIXTURES.filter((fixture) => sqlStatusMatches(fixture, "all"));
    expect(mirrorIds).toEqual(serverOrder(visible, sort));
  });

  it("breaks exact key ties by id, in the sort's direction, on every sort", async () => {
    // book-07/book-08 tie on activity, added, title and author alike.
    for (const sort of SORTS) {
      const ids = (await listMirrorBooks(USER, { sort })).map((row) => row.id);
      const pair = ids.filter((id) => id === "book-07" || id === "book-08");
      expect(pair).toEqual(
        librarySortsAscending(sort) ? ["book-07", "book-08"] : ["book-08", "book-07"],
      );
    }
  });

  it.each(STATUSES)("classifies the %s facet exactly as statusCondition does", async (status) => {
    const mirrorIds = (await listMirrorBooks(USER, { status })).map((row) => row.id);
    const expected = FIXTURES.filter((fixture) => sqlStatusMatches(fixture, status)).map(
      (fixture) => fixture.book.id,
    );
    expect([...mirrorIds].sort()).toEqual(expected.sort());
    expect(mirrorIds.length).toBeGreaterThan(0); // every facet is exercised
  });

  it("matches search needles exactly as the SQL predicate does", async () => {
    const needles = [
      "zebra", // title, lowercased on both sides
      "APPLE", // caller case is normalized before matching
      "ann blake", // spans the author/narrator boundary: pins the ' ' separator
      "seasons", // series column participates
      "sci-fi", // tag-only match, no text match
      "hist", // tag substring
      // A null narrator becomes coalesce('') between two separators, so the
      // author/series boundary is a DOUBLE space on both sides of the parity.
      "brontë  seasons",
      "brontë seasons", // ...and the single-space needle must NOT match
      "nowhere-at-all", // matches nothing
    ];
    for (const raw of needles) {
      const needle = raw.trim().toLowerCase();
      const mirrorIds = (await listMirrorBooks(USER, { query: raw })).map((row) => row.id);
      const expected = FIXTURES.filter(
        (fixture) => sqlStatusMatches(fixture, "all") && sqlSearchMatches(fixture, needle),
      ).map((fixture) => fixture.book.id);
      expect([...mirrorIds].sort(), `needle: ${raw}`).toEqual(expected.sort());
    }
    // The fixture set makes every needle category meaningful, including empty.
    expect((await listMirrorBooks(USER, { query: "brontë  seasons" })).length).toBe(1);
    expect((await listMirrorBooks(USER, { query: "nowhere-at-all" })).length).toBe(0);
  });

  it("filters by tag facet the way the server's exists-subquery does", async () => {
    for (const tag of ["Sci-Fi", "history", "absent"]) {
      const mirrorIds = (await listMirrorBooks(USER, { tag })).map((row) => row.id);
      const expected = FIXTURES.filter(
        (fixture) =>
          sqlStatusMatches(fixture, "all") && TAG_NAMES_BY_BOOK.get(fixture.book.id)!.includes(tag),
      ).map((fixture) => fixture.book.id);
      expect([...mirrorIds].sort(), `tag: ${tag}`).toEqual(expected.sort());
    }
  });

  it("picks the same continue-listening book as getLibraryOverview's ORDER BY", async () => {
    // Server: in-progress rows ordered by playback_states.updated_at desc, id desc.
    const candidates = FIXTURES.filter(
      (fixture) => fixture.state && sqlStatusMatches(fixture, "in-progress"),
    ).sort((left, right) => {
      const byListen = right.state!.updatedAt.localeCompare(left.state!.updatedAt);
      return byListen || right.book.id.localeCompare(left.book.id);
    });
    const continueBook = await getMirrorContinueBook(USER);
    expect(continueBook?.id).toBe(candidates[0]!.book.id);
  });
});
