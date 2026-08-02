/**
 * The sync outbox, split by responsibility (`offline-sync/`):
 *
 * - `db.ts` — the IndexedDB schema, versioned migrations and record shapes.
 * - `keys.ts` — the coalesce-key builders that give every intent its identity.
 * - `queue.ts` — journalling and the coalescing policy.
 * - `sequences.ts` — per-book device-sequence counters and their purge.
 * - `replay.ts` — the drain: wire forms, retry classification, delivery.
 * - `reconcile.ts` — what a 409 means, and re-pointing a merged book's rows.
 *
 * This barrel is the module's public surface; nothing outside `offline-sync/`
 * imports the internals directly, and helpers the siblings share stay off it.
 */
export { type MutationKind, type QueuedMutation, type QueuedProgress } from "./offline-sync/db";
export {
  archiveMutationKey,
  collectionMutationKey,
  eventMutationKey,
  metadataMutationKey,
  progressMutationKey,
  tagMutationKey,
} from "./offline-sync/keys";
export {
  buildMutation,
  buildProgressMutation,
  clearQueuedMutationsForUser,
  listQueuedMutationUserIds,
  listQueuedMutations,
  MUTATION_COALESCING,
  newMutationId,
  queueMutation,
  queueProgress,
  toProgressBody,
  withProgressMutationLock,
  type MutationDraft,
} from "./offline-sync/queue";
export {
  currentDeviceSequence,
  nextDeviceSequence,
  purgeDeviceSequencesForUser,
} from "./offline-sync/sequences";
export {
  REPLAY_CONCURRENCY,
  REPLAY_PAGE_SIZE,
  replayQueuedMutations,
  shouldRetainMutation,
  toReplayRequest,
  type ReplayRequest,
} from "./offline-sync/replay";
export {
  reconcileProgressConflict,
  registerImportReattachedHandler,
  registerProgressConflictHandler,
} from "./offline-sync/reconcile";
