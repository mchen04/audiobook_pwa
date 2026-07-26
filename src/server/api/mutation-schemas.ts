import { z } from "zod";

import { PLAYBACK_ACTIONS } from "@/domain/playback-history";
import { SKIP_BOUNDS_MS } from "@/lib/preferences";

/**
 * Every mutation route's accepted request shape, in one place.
 *
 * This module exists because of a real lost write. `toReplayRequest` built a
 * tag-edge body of `{ tagId, include }` and sent it to `PATCH /api/books/:id`,
 * whose schema knew only `tags: string[]`. Zod stripped the unknown keys, the
 * handler applied nothing, answered 200, and the outbox deleted the row as
 * settled — while the mirror had already shown the user the change. The next
 * pull reverted it. Nothing anywhere failed.
 *
 * Two things prevent a repeat:
 *
 * 1. **Every schema is `.strict()`.** A body the route does not understand is
 *    now a 400, not a silent strip. The outbox treats a 4xx as terminal, so a
 *    shape mismatch is still a dropped write — but it is a loud one, visible in
 *    logs and caught by the schema-conformance test rather than surfacing weeks
 *    later as "my tags keep coming back".
 * 2. **The schemas are importable.** `mutation-replay-contract.test.ts` runs
 *    every `toReplayRequest` body through the real schema of the real route it
 *    targets, so a client and a route can no longer drift apart unnoticed.
 *
 * Route handlers must import from here rather than declaring their own, or the
 * test above is verifying a schema nothing uses.
 */

// ---------------------------------------------------------------------------
// PATCH /api/books/[bookId]
// ---------------------------------------------------------------------------

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable();

/**
 * One book↔tag edge, addressed by tag id.
 *
 * The whole-`tags` form replaces a book's entire vocabulary and is what the
 * details dialog sends; it cannot express "remove exactly this edge" from a
 * device that queued the intent offline without also clobbering any tag another
 * device added in the meantime. The edge form is add-wins per edge, which is
 * what the design contract's conflict table asks for (section 7).
 */
export const tagEdgeSchema = z.strictObject({
  tagId: z.uuid(),
  include: z.boolean(),
  /**
   * The tag's name as the queueing device knew it. Optional, and the reason the
   * edge survives the gap between queue and replay: the server collects a tag
   * the instant no book references it, so an edge naming only an id can arrive
   * pointing at a row that no longer exists. With the name the vocabulary entry
   * is re-established instead of the write being dropped as a terminal 404.
   */
  name: z.string().trim().min(1).max(80).optional(),
});

export const bookPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().min(1).max(240),
    narrator: optionalTrimmed(240),
    description: optionalTrimmed(5000),
    series: optionalTrimmed(240),
    seriesPosition: z.number().min(0).max(999_999).nullable(),
    archived: z.boolean(),
    tags: z.array(z.string().trim().min(1).max(80)).max(20),
    tagEdge: tagEdgeSchema,
    /** The outbox's idempotency key; makes a replayed edge a no-op. */
    mutationId: z.uuid(),
  })
  .partial()
  .strict()
  .refine((value) => !(value.tags !== undefined && value.tagEdge !== undefined), {
    message: "Send either the whole tag list or a single edge, never both.",
  });

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export const collectionCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export const collectionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bookId: z.uuid(),
    include: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => value.name !== undefined || value.bookId !== undefined)
  .refine((value) => (value.bookId === undefined) === (value.include === undefined));

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const skipMs = z.number().int().min(SKIP_BOUNDS_MS.min).max(SKIP_BOUNDS_MS.max);

export const preferencesPatchSchema = z
  .object({
    skipBackMs: skipMs,
    skipForwardMs: skipMs,
    smartRewind: z.boolean(),
    autoplayNextInCollection: z.boolean(),
  })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export const progressSchema = z.strictObject({
  deviceId: z.string().min(16).max(100),
  deviceSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  playbackRate: z.number().min(0.5).max(3),
  completed: z.boolean(),
  eventOccurredAt: z.coerce.date(),
});

export const playbackActionSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(PLAYBACK_ACTIONS),
  positionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  previousPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  playbackRate: z.number().min(0.5).max(3),
  description: z.string().trim().min(1).max(160).nullable(),
  occurredAt: z.coerce.date(),
});

export const listeningSessionSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * The outbox's idempotency key. Optional so builds that predate the
   * generalized outbox keep working; the client always sends it.
   */
  mutationId: z.uuid().optional(),
});

/**
 * The same listening stretch as it arrives from the outbox.
 *
 * `toReplayRequest` gives every `history` mutation the same wire form —
 * `POST /api/books/:id/history` with `id` set to the row's `mutationId` — so a
 * listening stretch queued on a device with no connection replays through that
 * one endpoint alongside the playback actions. The idempotency key therefore
 * arrives as `id` here rather than as `mutationId`; it is required, because an
 * append-only insert with no receipt to claim would record the same listen
 * twice on the first retry.
 */
export const listeningStretchSchema = z.strictObject({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  startPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  endPositionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Everything `POST /api/books/:id/history` accepts.
 *
 * One book's history has two kinds of entry — the discrete actions the player
 * records (`playbackActionSchema`) and the contiguous stretches the listening
 * tracker measures — and the outbox has exactly one `history` mutation kind to
 * carry both. The two shapes share no required key (`action` versus
 * `startedAt`), so the union discriminates without ambiguity, and both halves
 * stay `.strict()`.
 */
export const playbackHistoryEventSchema = z.union([playbackActionSchema, listeningStretchSchema]);

// ---------------------------------------------------------------------------
// POST /api/books/local
// ---------------------------------------------------------------------------

// Reverend-Insanity-scale ceilings, not upload limits: the audio bytes never
// reach the server, so these only bound what one registration may write.
export const MAX_CHAPTERS = 10_000;
export const MAX_DURATION_MS = 1_000 * 60 * 60 * 1_000; // 1,000 hours
export const MAX_BYTE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB

const chapterSchema = z.strictObject({
  position: z.number().int().min(0),
  title: z.string().min(1).max(500),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
});

export const bookRegistrationSchema = z.strictObject({
  /**
   * The id the importing device already keyed its local audio under.
   *
   * An import is journalled in the outbox before the network is touched, so the
   * registration may not reach the server for days — and the device needs a
   * book id *now*, to key the MP3 it just wrote into Cache Storage. Letting the
   * device name the book is what makes the row that eventually lands the same
   * book the device has been playing all along, instead of a second copy the
   * next pull adds beside it.
   *
   * Optional: a registration with no id gets a server-generated one, which is
   * what every build before the outbox sent.
   */
  bookId: z.uuid().optional(),
  fileName: z.string().min(1).max(8192),
  byteSize: z.number().int().positive().max(MAX_BYTE_SIZE),
  durationMs: z.number().int().positive().max(MAX_DURATION_MS),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  fingerprintKind: z.literal("sha256-v1"),
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().min(1).max(240),
  narrator: z.string().trim().min(1).max(240).nullable(),
  chapterDiagnostic: z.string().trim().min(1).max(300).nullable(),
  chapters: z.array(chapterSchema).min(1).max(MAX_CHAPTERS),
});
