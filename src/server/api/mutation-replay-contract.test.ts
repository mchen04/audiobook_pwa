import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import {
  listQueuedMutations,
  progressMutationKey,
  toReplayRequest,
  type MutationKind,
} from "@/lib/offline-sync";
import {
  commitArchiveChange,
  commitBookDeletion,
  commitCollectionEdge,
  commitDraft,
  commitHistoryEvent,
  commitImport,
  commitMetadataEdit,
  commitTagEdge,
} from "@/lib/offline/outbox";

import {
  bookPatchSchema,
  bookRegistrationSchema,
  collectionPatchSchema,
  listeningSessionSchema,
  playbackActionSchema,
  preferencesPatchSchema,
  progressSchema,
} from "./mutation-schemas";

/**
 * The bug this suite exists for.
 *
 * `toReplayRequest` built a tag edge as `{ tagId, include }` and sent it to
 * `PATCH /api/books/:id`, whose schema knew only `tags: string[]`. Zod stripped
 * both keys, the handler updated nothing, the route answered **200**, and
 * `settleMutation` deleted the outbox row as successfully delivered. The mirror
 * had already shown the user the change optimistically, so the edit looked
 * applied — until the next pull silently reverted it.
 *
 * Nothing failed anywhere. No error, no retry, no log. That is the dangerous
 * shape of this bug class, and it is why the check below is a *contract* test:
 * it runs the body the client actually builds through the schema of the route
 * it actually targets, for every mutation kind, so the two halves cannot drift
 * apart in silence again.
 */

const USER = "user-a";
const BOOK = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const COLLECTION = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const TAG = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const DEVICE = { userId: USER, deviceId: "device-abcdefghijklmnop" };

beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
});

function registration() {
  return {
    fileName: "book.mp3",
    byteSize: 1_000,
    durationMs: 60_000,
    fingerprint: "a".repeat(64),
    fingerprintKind: "sha256-v1" as const,
    title: "Title",
    author: "Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "One", startMs: 0, endMs: 60_000 }],
  };
}

/**
 * One representative mutation per kind, queued through the production API, plus
 * the schema of the route `toReplayRequest` sends it to.
 */
const KINDS: {
  kind: MutationKind;
  queue: () => Promise<unknown>;
  url: string;
  /** Null where the route takes no JSON body. */
  schema: { safeParse: (value: unknown) => { success: boolean } } | null;
}[] = [
  {
    kind: "progress",
    queue: () =>
      commitDraft({
        key: progressMutationKey({ userId: USER, bookId: BOOK, deviceId: DEVICE.deviceId }),
        userId: USER,
        kind: "progress",
        entityId: BOOK,
        payload: {
          positionMs: 5_000,
          playbackRate: 1,
          completed: false,
          eventOccurredAt: "2026-07-05T00:00:00.000Z",
        },
        deviceId: DEVICE.deviceId,
        deviceSequence: 1,
      }),
    url: `/api/books/${BOOK}/progress`,
    schema: progressSchema,
  },
  {
    kind: "metadata",
    queue: () => commitMetadataEdit(DEVICE, BOOK, { title: "Renamed", author: "Author" }),
    url: `/api/books/${BOOK}`,
    schema: bookPatchSchema,
  },
  {
    kind: "archive",
    queue: () => commitArchiveChange(DEVICE, BOOK, true),
    url: `/api/books/${BOOK}`,
    schema: bookPatchSchema,
  },
  {
    kind: "tag",
    queue: () => commitTagEdge(DEVICE, BOOK, TAG, false),
    url: `/api/books/${BOOK}`,
    schema: bookPatchSchema,
  },
  {
    kind: "collection",
    queue: () => commitCollectionEdge(DEVICE, COLLECTION, BOOK, true),
    url: `/api/collections/${COLLECTION}`,
    schema: collectionPatchSchema,
  },
  {
    kind: "history",
    queue: () =>
      commitHistoryEvent(DEVICE, BOOK, {
        action: "seek",
        positionMs: 1_000,
        previousPositionMs: 0,
        playbackRate: 1,
        description: null,
        occurredAt: "2026-07-05T00:00:00.000Z",
      }),
    url: `/api/books/${BOOK}/history`,
    schema: playbackActionSchema,
  },
  {
    kind: "import",
    queue: () => commitImport(DEVICE, "a".repeat(64), registration()),
    url: "/api/books/local",
    schema: bookRegistrationSchema,
  },
  {
    kind: "delete",
    queue: () => commitBookDeletion(DEVICE, BOOK),
    url: `/api/books/${BOOK}`,
    schema: null,
  },
];

describe("every replayed mutation is a shape its route accepts", () => {
  it("covers every mutation kind", () => {
    const covered = KINDS.map((entry) => entry.kind).sort();
    const declared: MutationKind[] = [
      "progress",
      "import",
      "metadata",
      "tag",
      "collection",
      "archive",
      "delete",
      "history",
    ];
    expect(covered, "add a case for the new kind").toStrictEqual([...declared].sort());
  });

  it.each(KINDS)("$kind replays to $url with a body the route validates", async (entry) => {
    await entry.queue();
    const [mutation] = await listQueuedMutations(USER);
    const request = toReplayRequest(mutation!);

    expect(request.url).toBe(entry.url);
    if (!entry.schema) {
      expect(request.init.body, "no body means nothing to validate").toBeUndefined();
      return;
    }

    const body = JSON.parse(String(request.init.body));
    const parsed = entry.schema.safeParse(body);
    expect(
      parsed.success,
      `${entry.kind} builds a body its route rejects or silently ignores: ${JSON.stringify(body)}`,
    ).toBe(true);
  });

  it("carries the idempotency key on every kind the server receipts", async () => {
    await commitTagEdge(DEVICE, BOOK, TAG, false);
    const [tag] = await listQueuedMutations(USER);
    const body = JSON.parse(String(toReplayRequest(tag!).init.body));
    expect(body.mutationId).toBe(tag!.mutationId);
    expect(body.tagEdge).toStrictEqual({ tagId: TAG, include: false });
  });
});

/**
 * The other half: proof that a wrong shape now *fails* instead of being
 * quietly discarded. Without `.strict()` every one of these parses, the route
 * applies nothing, and the outbox settles a write that never happened.
 */
describe("mutation schemas reject a body they do not understand", () => {
  it("rejects the exact flat tag-edge body that caused the lost write", () => {
    expect(bookPatchSchema.safeParse({ tagId: TAG, include: false }).success).toBe(false);
  });

  it("refuses a whole-list and a single-edge tag update in one request", () => {
    expect(
      bookPatchSchema.safeParse({ tags: ["fiction"], tagEdge: { tagId: TAG, include: true } })
        .success,
    ).toBe(false);
  });

  it.each([
    ["bookPatchSchema", bookPatchSchema, { title: "T", nonsense: 1 }],
    ["collectionPatchSchema", collectionPatchSchema, { bookId: BOOK, include: true, extra: 1 }],
    ["preferencesPatchSchema", preferencesPatchSchema, { skipBackMs: 15_000, extra: 1 }],
    [
      "progressSchema",
      progressSchema,
      {
        deviceId: "device-abcdefghijklmnop",
        deviceSequence: 1,
        positionMs: 0,
        playbackRate: 1,
        completed: false,
        eventOccurredAt: "2026-07-05T00:00:00.000Z",
        extra: 1,
      },
    ],
    ["listeningSessionSchema", listeningSessionSchema, { extra: 1 }],
    ["bookRegistrationSchema", bookRegistrationSchema, { ...registration(), extra: 1 }],
  ])("%s rejects an unknown key", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it("still accepts every shape the existing UI sends", () => {
    expect(
      bookPatchSchema.safeParse({
        title: "T",
        author: "A",
        narrator: null,
        description: null,
        series: null,
        seriesPosition: null,
        tags: ["fiction"],
      }).success,
    ).toBe(true);
    expect(bookPatchSchema.safeParse({ archived: true }).success).toBe(true);
    expect(collectionPatchSchema.safeParse({ bookId: BOOK, include: true }).success).toBe(true);
    expect(
      preferencesPatchSchema.safeParse({
        skipBackMs: 15_000,
        skipForwardMs: 30_000,
        smartRewind: true,
        autoplayNextInCollection: false,
      }).success,
    ).toBe(true);
  });
});
