import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { database, mirrorKey, offlineBookKey } from "./offline/db";
import { listStoredOfflineBooks } from "./offline/library";
import {
  commitBookDeletion,
  commitCollectionEdge,
  commitHistoryEvent,
  commitImport,
  commitMetadataEdit,
  commitTagEdge,
} from "./offline/outbox";
import {
  clearQueuedMutationsForUser,
  currentDeviceSequence,
  listQueuedMutations,
  nextDeviceSequence,
  queueProgress,
  replayQueuedMutations,
  type QueuedMutation,
  type QueuedProgress,
} from "./offline-sync";

function progressEntry(overrides: Partial<QueuedProgress> = {}): QueuedProgress {
  return {
    userId: "user-a",
    bookId: "book-1",
    deviceId: "device-1",
    deviceSequence: 1,
    positionMs: 5_000,
    playbackRate: 1.5,
    completed: false,
    eventOccurredAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  await clearQueuedMutationsForUser("user-a");
  await clearQueuedMutationsForUser("user-b");
});

describe("offline progress queue", () => {
  it("replays queued progress once the network answers", async () => {
    await queueProgress(progressEntry());
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe("/api/books/book-1/progress");
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).deviceSequence).toBe(1);
  });

  it("keeps transient failures queued until a later success", async () => {
    await queueProgress(progressEntry());
    const unavailable = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    await replayQueuedMutations("user-a", unavailable as typeof fetch);
    expect(unavailable).toHaveBeenCalledTimes(2);

    const succeeding = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    await replayQueuedMutations("user-a", succeeding as typeof fetch);
    expect(succeeding).toHaveBeenCalledOnce();
  });

  it("compacts progress to the newest device sequence", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1, positionMs: 1_000 }));
    await queueProgress(progressEntry({ deviceSequence: 3, positionMs: 3_000 }));
    await queueProgress(progressEntry({ deviceSequence: 2, positionMs: 2_000 }));
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).deviceSequence).toBe(3);
  });

  it("does not erase progress queued while replay is in flight", async () => {
    await queueProgress(progressEntry({ deviceSequence: 1 }));
    const fetchFn = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      await queueProgress(progressEntry({ deviceSequence: 2 }));
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);
    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchFn.mock.calls[1]?.[1]?.body as string).deviceSequence).toBe(2);
  });

  /**
   * MEASURED, WebKit, hard kill: Postgres left holding 15245 ms against a true
   * position of 3231 ms. The 15 s heartbeat queued the pre-rewind position, the
   * kill took the write that would have followed the rewind, and replay then
   * published the queued value — carrying its ORIGINAL `eventOccurredAt`, which
   * the server compares against what IT holds rather than against what the
   * device knows. The user was left ~12 s ahead of themselves the moment the
   * server became authoritative (a fresh install, a second device, cleared
   * storage). These three rows pin the collapse, its bounds, and the case it
   * must not touch.
   */
  describe("a queued progress row against a newer local position", () => {
    const KEY = "chapterline:position:user-a:book-1";

    function withLocalStorage(entries: Record<string, string>) {
      const store = new Map(Object.entries(entries));
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() {
          return store.size;
        },
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("replays the newer local position instead of the stale queued one", async () => {
      await queueProgress(
        progressEntry({ deviceSequence: 4, positionMs: 15_245, playbackRate: 1.5 }),
      );
      withLocalStorage({
        [KEY]: JSON.stringify({
          positionMs: 3_231,
          occurredAt: Date.parse("2026-07-09T00:00:05.000Z"),
          playbackRate: 1.5,
          completed: false,
        }),
      });
      const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      await replayQueuedMutations("user-a", fetchFn as typeof fetch);

      const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
      expect(body.positionMs).toBe(3_231);
      expect(body.eventOccurredAt).toBe("2026-07-09T00:00:05.000Z");
      // A carried-over sequence is a write the server answers 200 to and then
      // discards, so the superseding row has to claim a fresh one.
      expect(body.deviceSequence).toBeGreaterThan(4);
      expect(await listQueuedMutations("user-a")).toHaveLength(0);
    });

    it("leaves the queued row alone when the local record is older", async () => {
      await queueProgress(progressEntry({ deviceSequence: 4, positionMs: 15_245 }));
      withLocalStorage({
        [KEY]: JSON.stringify({
          positionMs: 3_231,
          occurredAt: Date.parse("2026-07-08T23:59:00.000Z"),
        }),
      });
      const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      await replayQueuedMutations("user-a", fetchFn as typeof fetch);

      const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
      expect(body.positionMs).toBe(15_245);
      expect(body.deviceSequence).toBe(4);
    });

    it("does not fold in a record that claims no moment at all", async () => {
      await queueProgress(progressEntry({ deviceSequence: 4, positionMs: 15_245 }));
      // Every pre-v2 local value parses to `occurredAt: 0`. It cannot claim to
      // be later than anything, which is the rule `localWinsOver` applies too.
      withLocalStorage({ [KEY]: "3231" });
      const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

      await replayQueuedMutations("user-a", fetchFn as typeof fetch);

      expect(JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string).positionMs).toBe(15_245);
    });
  });

  it("allocates device sequences transactionally", async () => {
    await expect(
      Promise.all([nextDeviceSequence("sequence-book"), nextDeviceSequence("sequence-book")]),
    ).resolves.toEqual(expect.arrayContaining([1, 2]));
  });

  it("replays large progress queues with bounded concurrency", async () => {
    for (let index = 0; index < 120; index += 1) {
      await queueProgress(
        progressEntry({
          bookId: `book-${String(index).padStart(3, "0")}`,
          deviceId: `device-${String(index).padStart(3, "0")}`,
        }),
      );
    }
    let active = 0;
    let maxActive = 0;
    const fetchFn = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations("user-a", fetchFn as typeof fetch);

    expect(fetchFn).toHaveBeenCalledTimes(120);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

/**
 * The offline half of design contract section 10.
 *
 * An import made with the network down mints its own book id and writes the
 * audio, the download record and the cues under it. The server answers the
 * replayed registration with 409 + `existingBookId` — the fingerprint already
 * belongs to another book — and that answer is the only thing that ever names
 * the canonical id on this device. Discarding it leaves the account holding two
 * books and this device holding audio nobody will ever ask for.
 */
describe("replaying an import the server merges by fingerprint", () => {
  const USER = "user-import";
  const MINTED = "minted-book-id";
  const CANONICAL = "canonical-book-id";
  const MEDIA_URL = "/offline-media/token-minted";

  let cacheAvailable = true;

  beforeEach(async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    cacheAvailable = true;
    const stored = new Map<string, Response>();
    vi.stubGlobal("caches", {
      open: async () => {
        if (!cacheAvailable) throw new Error("Cache Storage is unavailable.");
        return {
          async match(url: string) {
            return stored.get(url) || new Response("stored");
          },
          async put(url: string, response: Response) {
            stored.set(url, response);
          },
          async delete(url: string) {
            return stored.delete(url);
          },
          async keys() {
            return [...stored.keys()].map((url) => new Request(url));
          },
        };
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What an offline import leaves behind: bytes under the id this device minted. */
  async function seedOfflineImport(bookId: string, offlineMediaUrl: string) {
    const db = await database();
    await db.put("downloads", {
      key: offlineBookKey(USER, bookId),
      userId: USER,
      book: {
        id: bookId,
        title: "Imported on a plane",
        author: "Author",
        durationMs: 600_000,
        chapters: [{ id: `${bookId}:0`, position: 0, title: "One", startMs: 0, endMs: 600_000 }],
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 1,
        completed: false,
      },
      offlineMediaUrl,
      offlineCoverUrl: null,
      offlineCoverThumbUrl: null,
      byteSize: 12_582_912,
      downloadedAt: "2026-07-20T00:00:00.000Z",
    });
    await db.put("cacheEntries", { url: offlineMediaUrl, userId: USER, bookId });
    await db.put("cacheEntries", { url: `${offlineMediaUrl}/chunk/0`, userId: USER, bookId });
  }

  /** The registration, queued through the production mutation API. */
  function queueRegistration(bookId: string) {
    return commitImport({ userId: USER, deviceId: "device-1" }, "fingerprint-abc", {
      bookId,
      fileName: "book.mp3",
      byteSize: 12_582_912,
      durationMs: 600_000,
      fingerprint: "fingerprint-abc",
      fingerprintKind: "sha256-v1",
      title: "Imported on a plane",
      author: "Author",
      narrator: null,
      chapterDiagnostic: null,
      chapters: [{ position: 0, title: "One", startMs: 0, endMs: 600_000 }],
    });
  }

  function duplicateAnswer() {
    return Response.json(
      {
        error: "This MP3 is already in your library.",
        existingBookId: CANONICAL,
        playerBook: {
          id: CANONICAL,
          title: "The book that already owns these bytes",
          author: "Author",
          durationMs: 600_000,
          chapters: [{ id: "chapter-uuid", position: 0, title: "One", startMs: 0, endMs: 600_000 }],
          initialPositionMs: 4_500,
          initialProgressOccurredAt: "2026-07-21T00:00:00.000Z",
          initialPlaybackRate: 1.25,
          completed: false,
        },
      },
      { status: 409 },
    );
  }

  it("moves this device's copy onto the book the server kept", async () => {
    await seedOfflineImport(MINTED, MEDIA_URL);
    await queueRegistration(MINTED);
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      void url;
      return duplicateAnswer();
    });

    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);

    expect(fetchFn.mock.calls[0]?.[0]).toBe("/api/books/local");
    expect(
      await listQueuedMutations(USER),
      "the registration is settled: the server has the book and there is nothing left to send",
    ).toStrictEqual([]);
    const records = await listStoredOfflineBooks(USER);
    expect(
      records.map((record) => record.book.id),
      "the audio is still filed under the id this device minted, so the user now has the same " +
        "audiobook twice: one copy no other device can see, and one that asks them to re-import " +
        "a file they already imported",
    ).toStrictEqual([CANONICAL]);
    expect(records[0]!.offlineMediaUrl, "the merge moved bytes instead of moving the record").toBe(
      MEDIA_URL,
    );
    expect(records[0]!.book.initialPositionMs).toBe(4_500);
    const db = await database();
    const owners = await db.getAllFromIndex("cacheEntries", "by-user", USER);
    expect(owners.map((row) => row.bookId)).toStrictEqual([CANONICAL, CANONICAL]);
  });

  it("keeps the registration queued when the merge could not be applied", async () => {
    await seedOfflineImport(MINTED, MEDIA_URL);
    await seedOfflineImport(CANONICAL, "/offline-media/token-canonical");
    await queueRegistration(MINTED);
    cacheAvailable = false;
    const fetchFn = vi.fn(async () => duplicateAnswer());

    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);

    const [queued] = await listQueuedMutations(USER);
    expect(
      queued,
      "the row was settled while this device still holds the audio under a dead id, and the " +
        "answer that named the live one is now gone",
    ).toBeDefined();
    expect(queued!.attempts).toBe(1);

    // The next drain asks again and gets the same deterministic answer.
    cacheAvailable = true;
    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);
    expect(await listQueuedMutations(USER)).toStrictEqual([]);
    expect((await listStoredOfflineBooks(USER)).map((record) => record.book.id)).toStrictEqual([
      CANONICAL,
    ]);
  });

  it("settles a 409 that names no other book, and touches nothing", async () => {
    await seedOfflineImport(MINTED, MEDIA_URL);
    await queueRegistration(MINTED);
    const fetchFn = vi.fn(async () =>
      Response.json(
        { error: "Chapter repair could not safely reconcile the audiobook duration." },
        { status: 409 },
      ),
    );

    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);

    expect(await listQueuedMutations(USER)).toStrictEqual([]);
    expect((await listStoredOfflineBooks(USER)).map((record) => record.book.id)).toStrictEqual([
      MINTED,
    ]);
  });

  /**
   * The writes the user made against the phantom.
   *
   * A book imported with no network is on this device's screen — the library
   * projects a download record the mirror has never heard of — so it can be
   * renamed, tagged, shelved, played and deleted while the registration is
   * still queued. Every one of those writes names the id this device minted.
   * When the merge takes that id away, a row still naming it replays into a
   * 404, which is terminal, and is dropped as settled: the rename is gone, the
   * tag is gone, and the DELETE is gone while the book quietly survives as the
   * canonical one.
   */
  describe("the writes queued against the id the merge abandons", () => {
    const OTHER_DEVICE_ORIGIN = { userId: USER, deviceId: "device-1" };

    /** Everything a user can queue about one book, through the production API. */
    async function queueEveryKindAgainst(bookId: string) {
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, bookId, { title: "Renamed offline" });
      await commitTagEdge(OTHER_DEVICE_ORIGIN, bookId, "tag-id", true);
      await commitCollectionEdge(OTHER_DEVICE_ORIGIN, "collection-id", bookId, true);
      await commitHistoryEvent(OTHER_DEVICE_ORIGIN, bookId, { action: "seek", positionMs: 10 });
      await queueProgress({
        userId: USER,
        bookId,
        deviceId: "device-1",
        deviceSequence: await nextDeviceSequence(bookId, USER),
        positionMs: 9_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: "2026-07-21T00:00:00.000Z",
      });
      await commitBookDeletion(OTHER_DEVICE_ORIGIN, bookId);
    }

    /** 409 for the registration; everything else is retryable, so it stays queued. */
    function mergeThenHold() {
      return vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === "/api/books/local") return duplicateAnswer();
        return new Response(null, { status: 503 });
      });
    }

    function addressed(rows: QueuedMutation[]) {
      return rows
        .map((row) =>
          row.kind === "collection"
            ? `${row.kind}:${row.payload.bookId}`
            : `${row.kind}:${row.entityId}`,
        )
        .sort();
    }

    it("re-addresses every one of them to the book the server kept", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      await queueEveryKindAgainst(MINTED);
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);

      const queued = await listQueuedMutations(USER);
      expect(
        addressed(queued),
        "a queued write still names the id the server threw away; it will replay into a 404, " +
          "which is terminal, and the user's write will be dropped as settled",
      ).toStrictEqual(
        ["collection", "delete", "history", "metadata", "progress", "tag"].map(
          (kind) => `${kind}:${CANONICAL}`,
        ),
      );
      expect(
        queued.every((row) => row.key.includes(CANONICAL)),
        "a row was re-addressed but kept its old coalesce key, so the next edit to the same " +
          "book would sit beside it instead of collapsing into it",
      ).toBe(true);
    });

    it("sends them to the surviving book, not to the id that no longer exists", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, MINTED, { title: "Renamed offline" });
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);
      const delivered = vi.fn(async (url: RequestInfo | URL) => {
        void url;
        return new Response(null, { status: 200 });
      });
      await replayQueuedMutations(USER, delivered as unknown as typeof fetch);

      expect(delivered.mock.calls.map((call) => String(call[0]))).toStrictEqual([
        `/api/books/${CANONICAL}`,
      ]);
      expect(await listQueuedMutations(USER)).toStrictEqual([]);
    });

    it("keeps the later edit when both books already had one queued", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, CANONICAL, {
        title: "Older, on the real book",
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, MINTED, { title: "Newer, on the phantom" });
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);

      const renames = (await listQueuedMutations(USER)).filter((row) => row.kind === "metadata");
      expect(
        renames.length,
        "the two edits are the same intent on the same book and must coalesce to one",
      ).toBe(1);
      expect(
        renames[0]!.payload.title,
        "the older edit overwrote the newer one instead of coalescing by the policy",
      ).toBe("Newer, on the phantom");
    });

    it("keeps the edit already on the surviving book when it is the later one", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, MINTED, { title: "Older, on the phantom" });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await commitMetadataEdit(OTHER_DEVICE_ORIGIN, CANONICAL, {
        title: "Newer, on the real book",
      });
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);

      const renames = (await listQueuedMutations(USER)).filter((row) => row.kind === "metadata");
      expect(renames.length).toBe(1);
      expect(renames[0]!.payload.title).toBe("Newer, on the real book");
    });

    it("re-stamps progress with a sequence the surviving book will accept", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      // This device has already sent progress for the canonical book, so the
      // server holds a high-water mark for (user, canonical, device). A carried
      // -over sequence below it is discarded by the server, which answers 200
      // while doing it — a write that reports success and vanishes.
      for (let index = 0; index < 5; index += 1) await nextDeviceSequence(CANONICAL, USER);
      const behind = await currentDeviceSequence(CANONICAL, USER);
      await queueProgress({
        userId: USER,
        bookId: MINTED,
        deviceId: "device-1",
        deviceSequence: await nextDeviceSequence(MINTED, USER),
        positionMs: 9_000,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: "2026-07-21T00:00:00.000Z",
      });
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);

      const [progress] = (await listQueuedMutations(USER)).filter((row) => row.kind === "progress");
      expect(progress?.entityId).toBe(CANONICAL);
      expect(
        progress!.deviceSequence,
        "the re-addressed position carries a sequence minted from the OTHER book's counter, so " +
          "the server will discard it and answer 200",
      ).toBeGreaterThan(behind);
    });

    it("does not drop them when they reach the server BEFORE the registration", async () => {
      // The order the outbox actually replays in: `archive`, `collection`,
      // `delete` and `history` all sort ahead of `import`, so the writes arrive
      // while the server still knows nothing about the book.
      await seedOfflineImport(MINTED, MEDIA_URL);
      await commitHistoryEvent(OTHER_DEVICE_ORIGIN, MINTED, { action: "seek", positionMs: 10 });
      await commitBookDeletion(OTHER_DEVICE_ORIGIN, MINTED);
      await queueRegistration(MINTED);
      const notFound = vi.fn(async (url: RequestInfo | URL) =>
        String(url) === "/api/books/local"
          ? new Response(null, { status: 503 })
          : Response.json({ error: "Not found" }, { status: 404 }),
      );

      await replayQueuedMutations(USER, notFound as unknown as typeof fetch);

      expect(
        (await listQueuedMutations(USER)).map((row) => row.kind).sort(),
        "a write the user made against a book this device has not registered yet was told the " +
          "book does not exist and dropped as terminal — including the delete",
      ).toStrictEqual(["delete", "history", "import"]);
    });

    it("stops holding them once the registration leaves the queue", async () => {
      // The bound: nothing waits forever on a book the server will never hear
      // about. With no registration queued, a 404 is terminal again.
      await commitHistoryEvent(OTHER_DEVICE_ORIGIN, MINTED, { action: "seek", positionMs: 10 });
      const notFound = vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 }));

      await replayQueuedMutations(USER, notFound as unknown as typeof fetch);

      expect(await listQueuedMutations(USER)).toStrictEqual([]);
    });

    it("is idempotent, so an interrupted drain can simply run again", async () => {
      await seedOfflineImport(MINTED, MEDIA_URL);
      await queueEveryKindAgainst(MINTED);
      await queueRegistration(MINTED);

      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);
      const first = addressed(await listQueuedMutations(USER));
      await queueRegistration(MINTED);
      await replayQueuedMutations(USER, mergeThenHold() as unknown as typeof fetch);

      expect(addressed(await listQueuedMutations(USER))).toStrictEqual(first);
    });
  });
});

/**
 * Deleting a book and re-picking its MP3 are two intents about one file.
 *
 * The outbox replays in key order with four requests in flight, not in the
 * order the user expressed them, so a registration queued BEFORE a delete lands
 * after it — finds the fingerprint free, because the delete just released it —
 * and creates the book again. Nothing is lost in transit; the delete is undone
 * by an intent the user had already superseded, and the book comes back.
 */
describe("a delete supersedes an unsent registration of the same file", () => {
  const USER = "user-supersede";
  const ORIGIN = { userId: USER, deviceId: "device-1" };
  const FINGERPRINT = "f".repeat(64);

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function queueRegistration(bookId: string) {
    return commitImport(ORIGIN, FINGERPRINT, { bookId, fingerprint: FINGERPRINT, title: "Book" });
  }

  /** The mirror row a pull leaves behind, which is where the delete reads the fingerprint. */
  async function mirrorBook(bookId: string) {
    const db = await database();
    await db.put("books", {
      key: mirrorKey(USER, bookId),
      userId: USER,
      bookId,
      title: "Book",
      author: "Author",
      narrator: null,
      description: null,
      series: null,
      seriesPosition: null,
      chapterDiagnostic: null,
      archivedAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      media: {
        originalFilename: "book.mp3",
        mimeType: "audio/mpeg",
        byteSize: 1,
        fingerprint: FINGERPRINT,
        fingerprintKind: "sha256-v1",
        durationMs: 1,
      },
      searchText: "book author",
    });
  }

  it("drops a re-import of the file whose book is being deleted", async () => {
    await mirrorBook("canonical-book");
    await queueRegistration("minted-second-copy");

    await commitBookDeletion(ORIGIN, "canonical-book");

    const queued = await listQueuedMutations(USER);
    expect(
      queued.map((row) => row.kind),
      "the queued re-registration outlived the delete: it will replay after it, find the " +
        "fingerprint free, and bring the deleted book back",
    ).toStrictEqual(["delete"]);
  });

  it("drops the registration of a device-only book by the id it minted", async () => {
    // No mirror row: this book exists nowhere but this device, which is exactly
    // the book the library projects from a download record.
    await queueRegistration("device-only-book");

    await commitBookDeletion(ORIGIN, "device-only-book");

    expect((await listQueuedMutations(USER)).map((row) => row.kind)).toStrictEqual(["delete"]);
  });

  it("keeps a re-import the user made AFTER deleting the book", async () => {
    await mirrorBook("canonical-book");
    await commitBookDeletion(ORIGIN, "canonical-book");

    await queueRegistration("minted-after-the-delete");

    expect(
      (await listQueuedMutations(USER)).map((row) => row.kind).sort(),
      "re-importing a file after deleting its book is a new intent, and dropping it would lose " +
        "the book the user just asked for",
    ).toStrictEqual(["delete", "import"]);
  });

  it("leaves another file's registration alone", async () => {
    await mirrorBook("canonical-book");
    await commitImport(ORIGIN, "a".repeat(64), { bookId: "other-book", title: "Other" });

    await commitBookDeletion(ORIGIN, "canonical-book");

    expect((await listQueuedMutations(USER)).map((row) => row.entityId).sort()).toStrictEqual([
      "a".repeat(64),
      "canonical-book",
    ]);
  });
});
