import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import { purgeDeviceSequencesForUser } from "@/lib/offline-sync";

import { database } from "./db";
import { clearLocalDataForUser } from "./library";
import { purgeUser } from "./mirror";

/**
 * Account lifecycle purge — `docs/local-first.md` section 11.
 *
 * A cached page, mirrored row, or downloaded file from one account must never
 * be readable by another. Every store that holds user data is keyed by `userId`
 * and carries a `by-user` index, which is what makes this a bounded, provable
 * sweep rather than a best-effort one.
 */

const SHELL_CACHE_PREFIX = "chapterline-shell-";

/**
 * The user-agnostic shell may survive an account switch: it contains no book
 * data and no user identity (section 8), which is precisely what makes caching
 * it safe across accounts. Anything else in a page cache is treated as
 * account-bearing and removed.
 */
function isUserAgnosticShellEntry(url: string): boolean {
  const { pathname } = new URL(url, "https://placeholder.invalid");
  return (
    pathname === "/offline" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/_next/static/")
  );
}

/**
 * Everything on this device belonging to one account: every mirror store, the
 * outbox, downloads and their Cache Storage media entries, transcripts,
 * playback history, that account's localStorage keys, and `ACTIVE_USER_KEY`.
 *
 * `purgeUser` and `clearLocalDataForUser` are the existing machinery and are
 * called rather than reimplemented, so a store added to either is purged here
 * without this module knowing about it.
 */
export async function purgeAccount(userId: string): Promise<void> {
  // The mirror first: it is the only part that is trivially re-fetchable, so a
  // failure later still leaves the account's readable library gone.
  await purgeUser(userId);
  const pages = await purgeCachedPages().then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await clearLocalDataForUser(userId);
  } catch (error) {
    if (pages) throw pages;
    throw error;
  }
  // Only once the sweep above has succeeded: until then these rows are the
  // retry record for media that may still be on disk, and dropping them would
  // orphan bytes nothing knows how to reclaim.
  await purgeDeletionJournal(userId);
  // Raises the device floor as it deletes, in one transaction, so this account
  // signing back in cannot restart its counters below what the server already
  // recorded. See `purgeDeviceSequencesForUser`.
  await purgeDeviceSequencesForUser(userId);
  if (pages) throw pages;
}

/**
 * The deletion journal outlives the download it describes — `removeOfflineBook`
 * leaves a completed row behind, swept a day later. Each row carries the
 * account's `userId` and the ids of the books it deleted, so leaving them is a
 * record of one account's library readable by the next one to sign in.
 */
async function purgeDeletionJournal(userId: string): Promise<void> {
  const db = await database();
  const keys = await db.getAllKeysFromIndex("deletions", "by-user", userId);
  if (!keys.length) return;
  const transaction = db.transaction("deletions", "readwrite");
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}

/** Drops every page-cache entry that is not part of the user-agnostic shell. */
export async function purgeCachedPages(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
  for (const name of names) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    await Promise.all(
      requests
        .filter((request) => !isUserAgnosticShellEntry(request.url))
        .map((request) => cache.delete(request)),
    );
  }
}

/**
 * Every account with data on this device. Read from the mirror, the download
 * journal and the transcript store together, so an account that only ever got
 * as far as one download is still found.
 */
export async function listLocalUserIds(): Promise<string[]> {
  const db = await database();
  const found = new Set<string>();
  const transaction = db.transaction(
    ["downloads", "transcripts", "cacheEntries", "deletions", "books", "preferences", "syncMeta"],
    "readonly",
  );
  const [downloads, transcripts, entries, deletions, books, preferences, syncMeta] =
    await Promise.all([
      transaction.objectStore("downloads").getAll(),
      transaction.objectStore("transcripts").getAll(),
      transaction.objectStore("cacheEntries").getAll(),
      transaction.objectStore("deletions").getAll(),
      transaction.objectStore("books").getAll(),
      // Both stores are keyed by `userId` itself, so their key list is the answer.
      transaction.objectStore("preferences").getAllKeys(),
      transaction.objectStore("syncMeta").getAllKeys(),
      transaction.done,
    ]);
  for (const row of [...downloads, ...transcripts, ...entries, ...deletions, ...books]) {
    found.add(row.userId);
  }
  for (const key of [...preferences, ...syncMeta]) found.add(String(key));
  return [...found];
}

/**
 * Sign-out purge. The account's data goes even if it is the only device that
 * ever held its downloads: signing out is an explicit statement that this
 * device should stop holding the account, and section 11 makes no exception.
 */
export function purgeOnSignOut(userId: string): Promise<void> {
  return purgeAccount(userId);
}

/**
 * Sign-in purge. Every account other than the one signing in is removed.
 *
 * DELIBERATE NARROWING of section 11's "purge runs on sign-in": purging the
 * incoming account's own data would delete that user's downloaded audio on
 * every single login, and the MP3 exists nowhere else (section 2) — it would
 * destroy the only copy of the only irreplaceable data in the product. Purging
 * every *other* account delivers the property the section is written for: a
 * crash between sign-out and sign-in cannot leave one account able to read
 * another's rows, because the next sign-in finishes the job.
 */
export async function purgeOnSignIn(incomingUserId: string): Promise<string[]> {
  const stale = (await listLocalUserIds()).filter((userId) => userId !== incomingUserId);
  const active = typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVE_USER_KEY);
  if (active && active !== incomingUserId && !stale.includes(active)) stale.push(active);
  const results = await Promise.allSettled(stale.map((userId) => purgeAccount(userId)));
  await purgeCachedPages().catch(() => undefined);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
  return stale;
}
