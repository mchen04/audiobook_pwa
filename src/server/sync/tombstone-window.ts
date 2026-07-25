/**
 * Which deletions one pull batch may report, and how they interact with the
 * single scalar cursor.
 *
 * Pure, and separate from `pull.ts`, because the failure it prevents is silent:
 * a tombstone stamped later than the last book page would drag the cursor past
 * book rows the batch never sent, and those books would then never be pulled
 * again. This is the same clamping the playback-state stream already needs.
 */

export type TombstoneWindow =
  | { emit: false }
  | {
      emit: true;
      /** Exclusive lower bound: deletions strictly after the device's cursor. */
      floor: string;
      /** Inclusive upper bound while book pages remain; null on the final page. */
      ceiling: string | null;
      /** False while pages remain — a clamped window must not move the cursor. */
      advancesCursor: boolean;
    };

/**
 * A first, full sync (`since === null`) reports no tombstones. The device holds
 * nothing yet, so there is nothing to delete, and the batch's own book list is
 * already the complete truth. Sending the account's entire deletion history to
 * a device that has never seen any of those books is pure waste.
 */
export function planTombstoneWindow(
  since: string | null,
  page: { complete: boolean; watermark: string },
): TombstoneWindow {
  if (since === null) return { emit: false };
  return page.complete
    ? { emit: true, floor: since, ceiling: null, advancesCursor: true }
    : { emit: true, floor: since, ceiling: page.watermark, advancesCursor: false };
}
