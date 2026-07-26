import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import {
  buildMutation,
  collectionMutationKey,
  listQueuedMutations,
  metadataMutationKey,
  progressMutationKey,
  queueProgress,
  replayQueuedMutations,
  tagMutationKey,
  toReplayRequest,
  type MutationDraft,
  type QueuedMutation,
} from "@/lib/offline-sync";

import { database, mirrorKey } from "./db";
import type { CommitResult } from "./outbox";
import {
  commitArchiveChange,
  commitBookDeletion,
  commitCollectionEdge,
  commitDraft,
  commitHistoryEvent,
  commitImport,
  commitMetadataEdit,
  commitMutation,
  commitTagEdge,
  mirrorProgress,
} from "./outbox";

const USER = "user-a";
const BOOK = "book-1";
const OTHER_BOOK = "book-2";
const COLLECTION = "collection-1";
/**
 * Tests drive the production mutation API, never a hand-written key. A test
 * that supplies its own key silently stops exercising the key builder, and the
 * key builder is what actually enforces the never-coalesce rule.
 */
const DEVICE = { userId: USER, deviceId: "device-1" };

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
});

function draft(overrides: Partial<MutationDraft> & Pick<MutationDraft, "key" | "kind">) {
  return {
    userId: USER,
    entityId: BOOK,
    payload: {},
    deviceId: "device-1",
    deviceSequence: 0,
    ...overrides,
  } as MutationDraft;
}

async function keys(): Promise<string[]> {
  return (await listQueuedMutations(USER)).map((row) => row.key).sort();
}

async function mirroredState() {
  const db = await database();
  return db.get("playbackStates", mirrorKey(USER, BOOK));
}

async function seedBook(overrides: Record<string, unknown> = {}) {
  const db = await database();
  await db.put("books", {
    key: mirrorKey(USER, BOOK),
    userId: USER,
    bookId: BOOK,
    title: "Original Title",
    author: "Author",
    narrator: null,
    description: null,
    series: null,
    seriesPosition: null,
    chapterDiagnostic: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    media: null,
    searchText: "original title author  ",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Coalescing — the table in `docs/local-first.md` section 5, rule 3
// ---------------------------------------------------------------------------

describe("outbox coalescing", () => {
  it("collapses progress per book and device to the highest device sequence", async () => {
    await queueProgress(progress(1, 1_000));
    await queueProgress(progress(3, 3_000));
    // Out of order: an older event must not overwrite a newer one.
    await queueProgress(progress(2, 2_000));

    const queued = await listQueuedMutations(USER);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.deviceSequence).toBe(3);
    expect(queued[0]!.payload.positionMs).toBe(3_000);
  });

  /**
   * `deviceSequence` is a per-(user, book, DEVICE) counter. The mirror guard
   * used to compare it across devices, which is comparing two unrelated
   * integers: a phone that has opened a book forty times outranked a laptop
   * opening it for the first time, so the laptop's genuinely newer position was
   * dropped from the shelf on the way past. Across devices the only ordering
   * the two share is the event time the server stamps.
   */
  it("projects a newer event over another device's higher sequence", async () => {
    await mirrorProgress({
      ...progress(9, 15_245),
      deviceId: "device-2",
      eventOccurredAt: "2026-07-05T00:00:00.000Z",
    });
    await mirrorProgress({
      ...progress(1, 3_231),
      deviceId: "device-1",
      eventOccurredAt: "2026-07-05T00:05:00.000Z",
    });

    expect((await mirroredState())?.positionMs).toBe(3_231);
  });

  it("still refuses an older event from another device", async () => {
    await mirrorProgress({
      ...progress(1, 3_231),
      deviceId: "device-2",
      eventOccurredAt: "2026-07-05T00:05:00.000Z",
    });
    await mirrorProgress({
      ...progress(9, 15_245),
      deviceId: "device-1",
      eventOccurredAt: "2026-07-05T00:00:00.000Z",
    });

    expect((await mirroredState())?.positionMs).toBe(3_231);
  });

  it("still orders one device's own events by its sequence", async () => {
    await mirrorProgress(progress(3, 3_000));
    // Same device, lower sequence: out of order, and the clock is not consulted.
    await mirrorProgress({ ...progress(2, 2_000), eventOccurredAt: "2026-07-06T00:00:00.000Z" });

    expect((await mirroredState())?.positionMs).toBe(3_000);
  });

  it("keeps a second device's progress for the same book separate", async () => {
    await queueProgress(progress(1, 1_000));
    await queueProgress({ ...progress(1, 9_000), deviceId: "device-2" });

    expect(await keys()).toStrictEqual([
      progressMutationKey({ userId: USER, bookId: BOOK, deviceId: "device-1" }),
      progressMutationKey({ userId: USER, bookId: BOOK, deviceId: "device-2" }),
    ]);
  });

  it("collapses tag edits per edge and never across edges", async () => {
    await commitTagEdge(DEVICE, BOOK, "tag-fiction", true);
    await commitTagEdge(DEVICE, BOOK, "tag-fiction", false);
    await commitTagEdge(DEVICE, BOOK, "tag-classics", true);

    const queued = await listQueuedMutations(USER);
    expect(queued).toHaveLength(2);
    expect(queued.find((row) => row.payload.tagId === "tag-fiction")!.payload.include).toBe(false);
    expect(queued.find((row) => row.payload.tagId === "tag-classics")!.payload.include).toBe(true);
  });

  it("keeps tag edges on two different books apart", async () => {
    await commitTagEdge(DEVICE, BOOK, "tag-fiction", true);
    await commitTagEdge(DEVICE, OTHER_BOOK, "tag-fiction", false);

    expect(await listQueuedMutations(USER)).toHaveLength(2);
  });

  it("collapses collection membership per edge and never across edges", async () => {
    await commitCollectionEdge(DEVICE, COLLECTION, BOOK, true);
    await commitCollectionEdge(DEVICE, COLLECTION, BOOK, false);
    await commitCollectionEdge(DEVICE, COLLECTION, OTHER_BOOK, true);

    const queued = await listQueuedMutations(USER);
    expect(queued).toHaveLength(2);
    expect(queued.find((row) => row.payload.bookId === BOOK)!.payload.include).toBe(false);
  });

  it("keeps the same book's membership in two collections apart", async () => {
    await commitCollectionEdge(DEVICE, COLLECTION, BOOK, true);
    await commitCollectionEdge(DEVICE, "collection-2", BOOK, false);

    expect(await listQueuedMutations(USER)).toHaveLength(2);
  });

  it("collapses renames per book and never across books", async () => {
    await commitMetadataEdit(DEVICE, BOOK, { title: "First" });
    await commitMetadataEdit(DEVICE, BOOK, { title: "Second" });
    await commitMetadataEdit(DEVICE, OTHER_BOOK, { title: "Other" });

    const queued = await listQueuedMutations(USER);
    expect(queued).toHaveLength(2);
    expect(queued.find((row) => row.entityId === BOOK)!.payload.title).toBe("Second");
  });

  it("keeps a rename and an archive on one book apart", async () => {
    await commitMetadataEdit(DEVICE, BOOK, { title: "Renamed" });
    await commitArchiveChange(DEVICE, BOOK, true);

    expect((await listQueuedMutations(USER)).map((row) => row.kind).sort()).toStrictEqual([
      "archive",
      "metadata",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The three kinds that must never coalesce
// ---------------------------------------------------------------------------

/**
 * These drive the production mutation API end to end — queue, then replay —
 * because the policy table and the key builder are two layers that both have to
 * hold, and asserting either one's value in isolation leaves the invariant
 * untested when the other silently stops doing its job. Dropping the
 * `mutationId` from the key makes every one of these red.
 */
describe("distinct events never coalesce", () => {
  const EVENTS: {
    kind: "import" | "delete" | "history";
    queue: (index: number) => Promise<CommitResult>;
    url: string;
  }[] = [
    {
      kind: "history",
      // play, pause, seek on one book: routine, and three separate writes.
      queue: (index) =>
        commitHistoryEvent(DEVICE, BOOK, {
          action: ["play", "pause", "seek"][index],
          positionMs: index * 1_000,
          playbackRate: 1,
        }),
      url: `/api/books/${BOOK}/history`,
    },
    {
      kind: "delete",
      queue: () => commitBookDeletion(DEVICE, BOOK),
      url: `/api/books/${BOOK}`,
    },
    {
      kind: "import",
      queue: (index) =>
        commitImport(DEVICE, "f".repeat(64), {
          fileName: `part-${index}.mp3`,
          byteSize: index + 1,
        }),
      url: "/api/books/local",
    },
  ];

  it.each(EVENTS)(
    "keeps three $kind events for one entity as three queued rows",
    async ({ queue }) => {
      await queue(0);
      await queue(1);
      await queue(2);

      const queued = await listQueuedMutations(USER);
      expect(queued, "each event is a distinct write; dropping one loses it").toHaveLength(3);
      expect(new Set(queued.map((row) => row.key)).size, "keys must be distinct").toBe(3);
      expect(new Set(queued.map((row) => row.mutationId)).size).toBe(3);
    },
  );

  it.each(EVENTS)("replays all three $kind events to the server", async ({ queue, url }) => {
    await queue(0);
    await queue(1);
    await queue(2);
    const seen: string[] = [];
    const fetchFn = vi.fn(async (requested: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(requested));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return Response.json({ ok: true, echo: body.id ?? null }, { status: 200 });
    });

    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);

    expect(fetchFn, "every queued event must reach the network").toHaveBeenCalledTimes(3);
    expect(seen).toStrictEqual([url, url, url]);
    expect(await listQueuedMutations(USER)).toStrictEqual([]);
  });

  it("keeps two history events distinct even when their payloads are identical", async () => {
    // Two identical seeks a second apart are two real events. Nothing about the
    // payload may be used to decide they are "the same" write.
    const event = { action: "seek", positionMs: 5_000, playbackRate: 1 };
    await commitHistoryEvent(DEVICE, BOOK, event);
    await commitHistoryEvent(DEVICE, BOOK, event);

    expect(await listQueuedMutations(USER)).toHaveLength(2);
  });

  /**
   * The other half of the invariant. The key stops two *different* events from
   * colliding; the `never` policy is what stops a re-queue of the *same* event
   * id from overwriting the row mid-replay and resetting its attempt count.
   * Both layers are load-bearing, so both are driven for all three kinds.
   */
  it.each(EVENTS)(
    "treats a re-queue of one $kind event id as the same single event",
    async ({ queue }) => {
      const { queued } = await queue(0);
      await commitMutation({ ...queued, attempts: 5, payload: { tampered: true } }, null);

      const rows = await listQueuedMutations(USER);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attempts, "the queued row must not be replaced").toBe(0);
      expect(rows[0]!.payload.tampered).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Journal intent before acting
// ---------------------------------------------------------------------------

describe("journal intent before acting", () => {
  it("makes the outbox row durable before the mirror is patched", async () => {
    await seedBook();
    let queuedDuringPatch: QueuedMutation[] = [];

    // The patch observes the outbox as it stood when the projection began.
    await commitMutation(buildMutation(renameDraft(BOOK, "Renamed")), async () => {
      queuedDuringPatch = await listQueuedMutations(USER);
    });

    expect(queuedDuringPatch, "intent must already be journaled").toHaveLength(1);
    expect(queuedDuringPatch[0]!.payload.title).toBe("Renamed");

    await commitDraft(renameDraft(BOOK, "Renamed"));
    const db = await database();
    expect((await db.get("books", mirrorKey(USER, BOOK)))!.title).toBe("Renamed");
  });

  it("keeps the write queued when the optimistic mirror patch fails", async () => {
    await seedBook();
    const boom = new Error("mirror patch failed");

    await expect(
      commitMutation(buildMutation(renameDraft(BOOK, "Renamed")), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The user's intent survives even though its local projection did not:
    // replay still delivers it, and the next pull re-mirrors the result.
    expect(await keys()).toStrictEqual([metadataMutationKey(USER, BOOK)]);
    const db = await database();
    expect((await db.get("books", mirrorKey(USER, BOOK)))!.title).toBe("Original Title");
  });

  it("lands the whole mirror patch or none of it", async () => {
    await seedBook();
    const db = await database();
    await db.put("bookTags", {
      key: mirrorKey(USER, BOOK, "tag-fiction"),
      userId: USER,
      bookId: BOOK,
      tagId: "tag-fiction",
    });

    await expect(
      commitMutation(buildMutation(tagDraft("tag-classics", true)), async (transaction) => {
        await transaction.objectStore("bookTags").delete(mirrorKey(USER, BOOK, "tag-fiction"));
        throw new Error("half way");
      }),
    ).rejects.toThrow("half way");

    expect(await db.get("bookTags", mirrorKey(USER, BOOK, "tag-fiction"))).toBeDefined();
  });

  it("does not project an intent that coalescing discarded", async () => {
    await seedBook();
    await queueProgress(progress(5, 5_000));
    const stale = buildMutation({
      key: progressMutationKey({ userId: USER, bookId: BOOK, deviceId: "device-1" }),
      userId: USER,
      kind: "progress",
      entityId: BOOK,
      payload: { positionMs: 1, playbackRate: 1, completed: false, eventOccurredAt: "x" },
      deviceId: "device-1",
      deviceSequence: 2,
    });

    const result = await commitMutation(stale);

    expect(result.mirrored).toBe(false);
    expect(result.queued.deviceSequence).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Optimistic projections
// ---------------------------------------------------------------------------

describe("optimistic mirror projection", () => {
  it("bumps the parent book when only a tag edge changed", async () => {
    await seedBook();
    await commitDraft(tagDraft("tag-fiction", true));

    const db = await database();
    const book = await db.get("books", mirrorKey(USER, BOOK));
    expect(book!.updatedAt > "2026-07-01T00:00:00.000Z").toBe(true);
    expect(await db.get("bookTags", mirrorKey(USER, BOOK, "tag-fiction"))).toBeDefined();
  });

  it("bumps the parent collection when only membership changed", async () => {
    const db = await database();
    await db.put("collections", {
      key: mirrorKey(USER, "collection-1"),
      userId: USER,
      collectionId: "collection-1",
      name: "Queue",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await commitDraft(collectionDraft(BOOK, true));

    const collection = await db.get("collections", mirrorKey(USER, "collection-1"));
    expect(collection!.updatedAt > "2026-07-01T00:00:00.000Z").toBe(true);
    expect(await db.get("collectionBooks", mirrorKey(USER, "collection-1", BOOK))).toBeDefined();
  });

  it("keeps a rename searchable immediately", async () => {
    await seedBook();
    await commitDraft(renameDraft(BOOK, "Moby Dick"));

    const db = await database();
    expect((await db.get("books", mirrorKey(USER, BOOK)))!.searchText).toContain("moby dick");
  });

  it("removes the whole aggregate on a delete without touching media", async () => {
    await seedBook();
    const db = await database();
    await db.put("chapters", {
      key: `${USER}:${BOOK}:000000`,
      userId: USER,
      bookId: BOOK,
      position: 0,
      title: "Opening",
      startMs: 0,
      endMs: 1,
    });
    await db.put("downloads", {
      key: `${USER}:${BOOK}`,
      userId: USER,
      book: { id: BOOK } as never,
      offlineMediaUrl: "/offline-media/book-1",
      offlineCoverUrl: null,
      byteSize: 1,
      downloadedAt: "2026-07-01T00:00:00.000Z",
    });

    await commitBookDeletion(DEVICE, BOOK);

    expect(await db.get("books", mirrorKey(USER, BOOK))).toBeUndefined();
    expect(await db.get("chapters", `${USER}:${BOOK}:000000`)).toBeUndefined();
    // The audio is the only copy that exists anywhere; sync bookkeeping must
    // never be what removes it.
    expect(await db.get("downloads", `${USER}:${BOOK}`)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotent replay
// ---------------------------------------------------------------------------

describe("idempotent replay", () => {
  it("reuses one mutation id across every retry", async () => {
    const { queued } = await commitHistoryEvent(DEVICE, BOOK, {
      action: "seek",
      positionMs: 10,
      playbackRate: 1,
    });
    const mutationId = queued.mutationId;
    const sent: string[] = [];
    const failing = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).id);
      return new Response(null, { status: 503 });
    });

    await replayQueuedMutations(USER, failing as unknown as typeof fetch);
    await replayQueuedMutations(USER, failing as unknown as typeof fetch);
    await replayQueuedMutations(USER, failing as unknown as typeof fetch);

    expect(sent).toStrictEqual([mutationId, mutationId, mutationId]);
    expect((await listQueuedMutations(USER))[0]!.attempts).toBe(3);
  });

  it("replays an already-applied mutation as a no-op rather than a double apply", async () => {
    await commitBookDeletion(DEVICE, BOOK);
    // The server has already applied this delete; the tombstone makes the
    // replay answer 200 instead of 404.
    const applied = vi.fn(async () =>
      Response.json({ deleted: true, alreadyDeleted: true }, { status: 200 }),
    );

    await replayQueuedMutations(USER, applied as unknown as typeof fetch);
    await replayQueuedMutations(USER, applied as unknown as typeof fetch);

    expect(applied).toHaveBeenCalledOnce();
    expect(await listQueuedMutations(USER)).toStrictEqual([]);
  });

  it("does not erase a newer intent when an older one is acknowledged", async () => {
    await seedBook();
    await commitDraft(renameDraft(BOOK, "First"));
    const fetchFn = vi.fn(async () => {
      await commitDraft(renameDraft(BOOK, "Second"));
      return new Response(null, { status: 200 });
    });

    await replayQueuedMutations(USER, fetchFn as unknown as typeof fetch);

    const queued = await listQueuedMutations(USER);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.title).toBe("Second");
  });

  it("sends every kind to the route that owns it", () => {
    const of = (kind: QueuedMutation["kind"]) =>
      toReplayRequest(buildMutation(draft({ key: "unused-for-routing", kind })));
    expect(of("progress").url).toBe(`/api/books/${BOOK}/progress`);
    expect(of("history").url).toBe(`/api/books/${BOOK}/history`);
    expect(of("import").url).toBe("/api/books/local");
    expect(of("collection").url).toBe(`/api/collections/${BOOK}`);
    expect(of("metadata").url).toBe(`/api/books/${BOOK}`);
    expect(of("archive").url).toBe(`/api/books/${BOOK}`);
    expect(of("tag").url).toBe(`/api/books/${BOOK}`);
    expect(of("delete").init.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function progress(deviceSequence: number, positionMs: number) {
  return {
    userId: USER,
    bookId: BOOK,
    deviceId: "device-1",
    deviceSequence,
    positionMs,
    playbackRate: 1,
    completed: false,
    eventOccurredAt: "2026-07-05T00:00:00.000Z",
  };
}

/**
 * Drafts for the few cases that need the raw mutation (injecting a failing
 * mirror patch, replaying a stale intent). Keys still come from the production
 * builders — a literal here would be a second implementation of the invariant.
 */
function tagDraft(tagId: string, include: boolean): MutationDraft {
  return draft({
    key: tagMutationKey(USER, BOOK, tagId),
    kind: "tag",
    payload: { tagId, include },
  });
}

function collectionDraft(bookId: string, include: boolean): MutationDraft {
  return draft({
    key: collectionMutationKey(USER, COLLECTION, bookId),
    kind: "collection",
    entityId: COLLECTION,
    payload: { bookId, include },
  });
}

function renameDraft(bookId: string, title: string): MutationDraft {
  return draft({
    key: metadataMutationKey(USER, bookId),
    kind: "metadata",
    entityId: bookId,
    payload: { title },
  });
}
