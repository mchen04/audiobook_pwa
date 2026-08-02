import { activeUserId, database, deviceSequenceKey, SEQUENCE_FLOOR_KEY } from "./db";

/**
 * Issues the next sequence for a book, and never issues one that is not
 * strictly greater than every value this device has previously recorded for it.
 *
 * The maximum is taken across the scoped key, the pre-v5 bare key and the
 * device floor, so no combination of a half-run migration, a missing
 * `ACTIVE_USER_KEY`, or an account purge can hand back a number the server has
 * already seen. `userId` is optional because the sync harness and the player
 * both call this with the book alone; the active account is the fallback.
 */
export async function nextDeviceSequence(bookId: string, userId?: string): Promise<number> {
  const owner = userId || activeUserId();
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const store = transaction.store;
  const scoped = owner ? deviceSequenceKey(owner, bookId) : null;

  const [scopedRow, legacyRow, floorRow] = await Promise.all([
    scoped ? store.get(scoped) : Promise.resolve(undefined),
    store.get(bookId),
    store.get(SEQUENCE_FLOOR_KEY),
  ]);
  const next = Math.max(scopedRow?.value || 0, legacyRow?.value || 0, floorRow?.value || 0) + 1;

  if (scoped) {
    await store.put({ key: scoped, userId: owner!, bookId, value: next });
    // Fold the unattributed row in only once its replacement holds a value at
    // least as high, so the counter cannot dip through the gap.
    if (legacyRow) await store.delete(bookId);
  } else {
    await store.put({ key: bookId, value: next });
  }
  await transaction.done;
  return next;
}

/**
 * The last sequence issued for this book, or 0. The device floor is
 * deliberately excluded: callers ask this to find out whether a newer event for
 * *this book* has been queued since, and another book's counter is not that.
 */
export async function currentDeviceSequence(bookId: string, userId?: string): Promise<number> {
  const owner = userId || activeUserId();
  const db = await database();
  const transaction = db.transaction("sequences", "readonly");
  const [scopedRow, legacyRow] = await Promise.all([
    owner ? transaction.store.get(deviceSequenceKey(owner, bookId)) : Promise.resolve(undefined),
    transaction.store.get(bookId),
    transaction.done,
  ]);
  return Math.max(scopedRow?.value || 0, legacyRow?.value || 0);
}

/**
 * Removes one account's replay counters, raising the device floor to the
 * highest value being removed in the SAME transaction.
 *
 * Either both happen or neither does. A purge that deleted the counters without
 * raising the floor would reset this device below what the server records and
 * silently discard the account's next writes; a purge that raised the floor
 * without deleting would leave the residue the sweep exists to remove.
 *
 * Rows that carry no owner (pre-v5, or written while signed out) are left
 * alone: nothing identifies them as this account's, and deleting them on a
 * guess would drop another account's counter.
 */
export async function purgeDeviceSequencesForUser(userId: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction("sequences", "readwrite");
  const store = transaction.store;
  const owned = await store.getAll(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`));
  if (!owned.length) {
    await transaction.done;
    return;
  }
  const floorRow = await store.get(SEQUENCE_FLOOR_KEY);
  const floor = owned.reduce((highest, row) => Math.max(highest, row.value), floorRow?.value || 0);
  await store.put({ key: SEQUENCE_FLOOR_KEY, value: floor });
  await Promise.all(owned.map((row) => store.delete(row.key)));
  await transaction.done;
}
