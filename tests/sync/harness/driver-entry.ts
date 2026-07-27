/**
 * The in-page bridge.
 *
 * This file is NOT a test. It is bundled by `driver-bundle.ts` and injected
 * into every page of every sync test with `context.addInitScript`, so the suite
 * can call the SHIPPING sync engine — the same modules `src/**` imports — from
 * inside a real browser.
 *
 * Why it exists at all: the fuzz needs to drive thousands of mutations across
 * randomized offline/online transitions, which no amount of clicking could
 * reach, and a verifier that hand-assembled outbox rows would be testing its
 * own key builder rather than the product's. Everything below is a thin forward
 * to a production export. Nothing here reimplements a key, a coalescing rule, a
 * replay request or a mirror projection.
 *
 * What this bridge CANNOT prove is that the shipping UI calls any of it — and
 * for a while it did not, which is how this project once had a green
 * zero-lost-writes fuzz over a module no button reached. That claim is now
 * owned by `../real-ui-writes.spec.ts`, which makes its edits by typing into
 * the real inputs and clicking the real buttons with the network off, and
 * never touches this driver until the assertions are done. If that spec is
 * ever deleted or weakened, everything below goes back to describing a module
 * rather than a product.
 *
 * The one place that is not a pure forward is `pull()`, which repeats the fetch
 * loop of `use-library-books.ts#pull` because that loop is not exported — but
 * even it applies batches with the production `applyPullBatch` and validates
 * them with the production `isPullBatch`.
 */

import { PROGRESS_CONFLICT_EVENT } from "@/lib/app-keys";
import {
  buildMutation,
  currentDeviceSequence,
  listQueuedMutations,
  nextDeviceSequence,
  progressMutationKey,
  replayQueuedMutations,
  type QueuedMutation,
} from "@/lib/offline-sync";
import {
  database,
  MEDIA_CACHE,
  type MirrorBook,
  type MirrorBookTag,
  type MirrorChapter,
  type MirrorCollection,
  type MirrorCollectionBook,
  type MirrorPlaybackState,
  type MirrorSyncMeta,
  type MirrorTag,
} from "@/lib/offline/db";
import { listStoredOfflineBooks } from "@/lib/offline/library";
import { applyPullBatch, getSyncMeta } from "@/lib/offline/mirror";
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
import { isPullBatch } from "@/lib/offline/sync-protocol";

type Origin = { userId: string; deviceId: string };

export type MirrorSnapshot = {
  books: MirrorBook[];
  chapters: MirrorChapter[];
  bookTags: MirrorBookTag[];
  tags: MirrorTag[];
  collections: MirrorCollection[];
  collectionBooks: MirrorCollectionBook[];
  playbackStates: MirrorPlaybackState[];
  syncMeta: MirrorSyncMeta | undefined;
  downloads: Array<{ bookId: string; byteSize: number; mediaMissingSince: string | null }>;
};

/**
 * One user intent, in the vocabulary the FUZZ generates. Each maps to exactly
 * one production commit function; the mapping is the only thing this file adds.
 */
export type FuzzOp =
  | { kind: "import"; fingerprint: string; payload: Record<string, unknown> }
  | { kind: "rename"; bookId: string; fields: Record<string, unknown> }
  | { kind: "tag"; bookId: string; tagId: string; include: boolean }
  | { kind: "collection"; collectionId: string; bookId: string; include: boolean }
  | { kind: "archive"; bookId: string; archived: boolean }
  | { kind: "delete"; bookId: string }
  | { kind: "history"; bookId: string; event: Record<string, unknown> }
  | {
      kind: "progress";
      bookId: string;
      positionMs: number;
      playbackRate: number;
      completed: boolean;
      eventOccurredAt: string;
    };

/** Mirror stores only. `downloads`, `transcripts`, `deletions` and `cacheEntries` are untouched. */
const MIRROR_STORES = [
  "books",
  "chapters",
  "playbackStates",
  "tags",
  "bookTags",
  "collections",
  "collectionBooks",
  "preferences",
  "listeningSessions",
  "syncMeta",
] as const;

const PULL_PAGE_LIMIT = 50;

class Driver {
  private origin: Origin = { userId: "", deviceId: "" };

  configure(userId: string, deviceId: string): void {
    this.origin = { userId, deviceId };
  }

  deviceId(): string {
    return this.origin.deviceId;
  }

  /**
   * Journals one user intent through the production mutation API.
   *
   * `progress` has no dedicated `commit*` helper in `outbox.ts` (the player
   * queues it through `offline-sync.ts`), so it goes through `commitDraft` with
   * the production `progressMutationKey` and the production
   * `nextDeviceSequence` — never a key string written here.
   */
  async commit(op: FuzzOp): Promise<{ mutationId: string; mirrored: boolean }> {
    const result = await this.dispatch(this.origin, op);
    return { mutationId: result.queued.mutationId, mirrored: result.mirrored };
  }

  private dispatch(origin: Origin, op: FuzzOp) {
    switch (op.kind) {
      case "import":
        return commitImport(origin, op.fingerprint, op.payload);
      case "rename":
        return commitMetadataEdit(origin, op.bookId, op.fields);
      case "tag":
        return commitTagEdge(origin, op.bookId, op.tagId, op.include);
      case "collection":
        return commitCollectionEdge(origin, op.collectionId, op.bookId, op.include);
      case "archive":
        return commitArchiveChange(origin, op.bookId, op.archived);
      case "delete":
        return commitBookDeletion(origin, op.bookId);
      case "history":
        return commitHistoryEvent(origin, op.bookId, op.event);
      case "progress":
        return this.commitProgress(origin, op);
    }
  }

  private async commitProgress(
    origin: Origin,
    op: Extract<FuzzOp, { kind: "progress" }>,
  ): ReturnType<typeof commitDraft> {
    const deviceSequence = await nextDeviceSequence(op.bookId);
    return commitDraft(
      buildMutation({
        key: progressMutationKey({
          userId: origin.userId,
          bookId: op.bookId,
          deviceId: origin.deviceId,
        }),
        userId: origin.userId,
        kind: "progress",
        entityId: op.bookId,
        payload: {
          positionMs: op.positionMs,
          playbackRate: op.playbackRate,
          completed: op.completed,
          eventOccurredAt: op.eventOccurredAt,
        },
        deviceId: origin.deviceId,
        deviceSequence,
      }),
    );
  }

  replay(): Promise<void> {
    return replayQueuedMutations(this.origin.userId);
  }

  outbox(): Promise<QueuedMutation[]> {
    return listQueuedMutations(this.origin.userId);
  }

  sequenceFor(bookId: string): Promise<number> {
    return currentDeviceSequence(bookId);
  }

  /** The pull loop of `use-library-books.ts`, applying with the production mirror writer. */
  async pull(): Promise<"applied" | "unauthorized" | "unreachable"> {
    const userId = this.origin.userId;
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
      await applyPullBatch(userId, batch);
      if (batch.complete) return "applied";
    }
    return "applied";
  }

  async mirror(): Promise<MirrorSnapshot> {
    const userId = this.origin.userId;
    const db = await database();
    const [
      books,
      chapters,
      bookTags,
      tags,
      collections,
      collectionBooks,
      playbackStates,
      syncMeta,
      downloads,
    ] = await Promise.all([
      db.getAllFromIndex("books", "by-user", userId),
      db.getAllFromIndex("chapters", "by-user-book", IDBKeyRange.bound([userId], [userId, "￿"])),
      db.getAllFromIndex("bookTags", "by-user", userId),
      db.getAllFromIndex("tags", "by-user", userId),
      db.getAllFromIndex("collections", "by-user", userId),
      db.getAllFromIndex("collectionBooks", "by-user", userId),
      db.getAllFromIndex("playbackStates", "by-user", userId),
      db.get("syncMeta", userId),
      listStoredOfflineBooks(userId),
    ]);
    return {
      books,
      chapters,
      bookTags,
      tags,
      collections,
      collectionBooks,
      playbackStates,
      syncMeta,
      downloads: downloads.map((record) => ({
        bookId: record.book.id,
        byteSize: record.byteSize,
        // Whether this device believes it still holds the audio. Reported so a
        // spec can tell "the record is gone" from "the record says the bytes
        // are not here" — the second is the state the product must reach.
        mediaMissingSince: record.mediaMissingSince ?? null,
      })),
    };
  }

  /**
   * Simulates Safari reclaiming the mirror: every mirror store is emptied,
   * including `syncMeta`, and nothing else in the database is touched. Written
   * with raw IndexedDB rather than `mirror.ts#purgeUser` on purpose — eviction
   * is the platform destroying data behind the app's back, not the app tidying
   * up, and using the app's own purge would test the wrong thing.
   */
  async evictMirror(): Promise<void> {
    const db = await database();
    const transaction = db.transaction(MIRROR_STORES, "readwrite");
    await Promise.all([
      ...MIRROR_STORES.map((store) => transaction.objectStore(store).clear()),
      transaction.done,
    ]);
  }

  /** Simulates Safari reclaiming Cache Storage: the audio bytes are gone. */
  async evictAudio(): Promise<{ removedCaches: string[] }> {
    const names = (await caches.keys()).filter((name) => name.startsWith("chapterline-media"));
    await Promise.all(names.map((name) => caches.delete(name)));
    return { removedCaches: names };
  }

  /**
   * Starts collecting `PROGRESS_CONFLICT_EVENT`, the mechanism design contract
   * section 7 says conflicts are surfaced through. Nothing here interprets the
   * event; the test asserts on the payload the app dispatched.
   */
  watchConflicts(): void {
    if (this.watchingConflicts) return;
    this.watchingConflicts = true;
    window.addEventListener(PROGRESS_CONFLICT_EVENT, (event) => {
      this.conflicts.push((event as CustomEvent<Record<string, unknown>>).detail);
    });
  }

  readonly conflicts: Array<Record<string, unknown>> = [];
  private watchingConflicts = false;

  observedConflicts(): Array<Record<string, unknown>> {
    return this.conflicts;
  }

  /**
   * Can this device actually play that book right now?
   *
   * The same two reads the player's gate makes (`local-media-gate.tsx`): the
   * download record for the id, then the media the record's own token points
   * at. Non-destructive on purpose — `getOfflineBook` reconciles a record whose
   * bytes are gone by marking it, and an observer that changed what it was
   * measuring would be useless here.
   */
  async playable(
    bookId: string,
  ): Promise<{ record: boolean; media: boolean; byteSize: number | null }> {
    const records = await listStoredOfflineBooks(this.origin.userId);
    const record = records.find((row) => row.book.id === bookId);
    if (!record) return { record: false, media: false, byteSize: null };
    const cache = await caches.open(MEDIA_CACHE);
    return {
      record: true,
      media: !!(await cache.match(record.offlineMediaUrl)),
      byteSize: record.byteSize,
    };
  }

  async mediaCacheEntries(): Promise<number> {
    if (!(await caches.keys()).includes(MEDIA_CACHE)) return 0;
    return (await (await caches.open(MEDIA_CACHE)).keys()).length;
  }
}

declare global {
  interface Window {
    __harkSync: Driver;
  }
}

window.__harkSync = new Driver();
