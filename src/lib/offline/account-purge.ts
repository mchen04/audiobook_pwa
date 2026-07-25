import { ACTIVE_USER_KEY } from "@/lib/app-keys";
import {
  listQueuedMutationUserIds,
  listQueuedMutations,
  purgeDeviceSequencesForUser,
  replayQueuedMutations,
  type MutationKind,
} from "@/lib/offline-sync";
import {
  listPendingPlaybackActions,
  listPlaybackHistoryUserIds,
  replayPlaybackHistory,
} from "@/lib/playback-history";

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
 * How long sign-out will wait for the outbox to reach the server before it
 * gives up and reports what it could not deliver.
 *
 * Bounded on purpose: a device that is offline, or talking to a server that
 * accepted the TCP connection and then went quiet, must still be able to sign
 * out. The bound is what stops "never lose a write" from turning into "never
 * finish signing out".
 */
export const SIGN_OUT_DRAIN_TIMEOUT_MS = 8_000;

/** A user write that was still on the device when the account left it. */
export type UndeliveredWrite = {
  kind: MutationKind | "playback-action";
  entityId: string;
  queuedAt: number;
};

export type SignOutOutcome = {
  /** Writes the server never acknowledged. Empty is the only good answer. */
  undelivered: UndeliveredWrite[];
  /** The purge itself failing, reported rather than thrown at the auth layer. */
  failure: unknown;
};

export type PurgeOptions = {
  drainTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /**
   * The result of a drain the caller already ran — which the auth client does,
   * before the sign-out request is sent and the session dies. Passing it is what
   * stops the drain from running a second time against a dead session, burning
   * the bound again and reporting the same write twice.
   */
  alreadyDrained?: UndeliveredWrite[];
};

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
 *
 * EVERY step runs, even after one has failed. A purge that abandoned the rest
 * of the sweep on the first error left the departed account's downloads,
 * deletion journal and replay counters on disk under the next account's
 * session — the precise thing section 11 forbids — and reported one error while
 * doing it. The steps are independent, so the only honest response to a failure
 * is to keep removing what can still be removed and report the aggregate.
 */
export async function purgeAccount(userId: string): Promise<void> {
  const failures: unknown[] = [];
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      failures.push(new Error(`${name} failed`, { cause: error }));
    }
  };

  // The mirror first: it is the only part that is trivially re-fetchable, so a
  // failure later still leaves the account's readable library gone.
  await step("mirror purge", () => purgeUser(userId));
  await step("page cache purge", () => purgeCachedPages());
  await step("local data purge", () => clearLocalDataForUser(userId));
  // The deletion journal names the account and the books it deleted, so it is
  // residue in its own right and goes whether or not the sweep above succeeded.
  // Nothing is orphaned by that: `cacheEntries` — not this journal — is what
  // records which bytes are in the media cache, and `retryAllPendingOfflineDeletions`
  // reclaims anything left over from it at the next launch.
  await step("deletion journal purge", () => purgeDeletionJournal(userId));
  // Raises the device floor as it deletes, in one transaction, so this account
  // signing back in cannot restart its counters below what the server already
  // recorded. See `purgeDeviceSequencesForUser`.
  await step("device sequence purge", () => purgeDeviceSequencesForUser(userId));
  // Sign-out is an unconditional statement that this device is no longer the
  // account's, so the key goes even when a step above could not finish.
  await step("active user key", async () => forgetActiveUser(userId));

  if (failures.length) throw asPurgeFailure("the account purge", failures);
}

function forgetActiveUser(userId: string): void {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(ACTIVE_USER_KEY) === userId) localStorage.removeItem(ACTIVE_USER_KEY);
}

/** One error when there is one, an aggregate when the sweep lost several. */
function asPurgeFailure(what: string, failures: unknown[]): Error {
  if (failures.length === 1) return failures[0] as Error;
  return new AggregateError(failures, `${failures.length} failures during ${what}`);
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
 * Every account with data on this device.
 *
 * All THREE databases are read, not just the mirror. An account whose only
 * remaining trace is an unsent mutation in `chapterline-sync-v1` or a recorded
 * seek in `hark-playback-history-v1` is still an account whose data the next
 * user of this device can read, and a sweep that enumerated one database would
 * never look at it.
 *
 * An enumeration source that cannot be read is reported rather than silently
 * treated as empty — but only after the accounts the other sources did find
 * have been swept, so one unopenable database cannot block the whole purge.
 */
export async function listLocalUserIds(): Promise<string[]> {
  const { users, failures } = await enumerateLocalUsers();
  if (failures.length) throw asPurgeFailure("the device enumeration", failures);
  return users;
}

async function enumerateLocalUsers(): Promise<{ users: string[]; failures: unknown[] }> {
  const sources = await Promise.allSettled([
    listMirrorUserIds(),
    listQueuedMutationUserIds(),
    listPlaybackHistoryUserIds(),
  ]);
  const found = new Set<string>();
  const failures: unknown[] = [];
  for (const source of sources) {
    if (source.status === "rejected") failures.push(source.reason);
    else for (const userId of source.value) found.add(userId);
  }
  return { users: [...found], failures };
}

/**
 * The offline database: the mirror, the download journal and the transcript
 * store together, so an account that only ever got as far as one download is
 * still found.
 */
async function listMirrorUserIds(): Promise<string[]> {
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
 *
 * The queue is DRAINED FIRST. Every user write in this product — a rename, a
 * tag, an archive, a collection edge, a delete, an import, listening history —
 * is journaled to the outbox and lives nowhere else until the server answers.
 * Clearing that queue is therefore destroying writes, and the only moment they
 * can still be delivered is now: the sign-out request has not been sent yet, so
 * the session cookie this replay needs is still valid.
 *
 * This never throws. It reports, because both halves of what it learns have to
 * reach the caller: writes it could not deliver (which the user must be told
 * about — they are gone from the device either way) and a purge step that
 * failed (which the next sign-in retries).
 */
export async function purgeOnSignOut(
  userId: string,
  options: PurgeOptions = {},
): Promise<SignOutOutcome> {
  const undelivered = options.alreadyDrained ?? (await drainBeforeSignOut(userId, options));
  const failure = await purgeAccount(userId).then(
    () => null,
    (error: unknown) => error,
  );
  return { undelivered, failure };
}

/**
 * Pushes the account's unsent writes to the server, bounded, and reports
 * whatever is still there afterwards.
 *
 * The replay is raced against a timer rather than aborted, because a request
 * that lands after the bound has expired still delivers its write — the row it
 * settles is removed by `settleMutation` regardless of who is waiting. The
 * bound only decides how long sign-out is willing to block.
 */
export async function drainBeforeSignOut(
  userId: string,
  options: PurgeOptions = {},
): Promise<UndeliveredWrite[]> {
  const [queued, actions] = await Promise.all([
    listQueuedMutations(userId).catch(() => []),
    listPendingPlaybackActions(userId).catch(() => []),
  ]);
  if (!queued.length && !actions.length) return [];

  const timeoutMs = options.drainTimeoutMs ?? SIGN_OUT_DRAIN_TIMEOUT_MS;
  let expire: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    expire = setTimeout(resolve, timeoutMs);
  });
  const drain = Promise.all([
    queued.length
      ? replayQueuedMutations(userId, options.fetchFn).catch(() => undefined)
      : Promise.resolve(),
    actions.length
      ? replayPlaybackHistory(userId, options.fetchFn).catch(() => undefined)
      : Promise.resolve(),
  ]).then(() => undefined);
  try {
    await Promise.race([drain, bound]);
  } finally {
    clearTimeout(expire);
  }

  const [remainingQueued, remainingActions] = await Promise.all([
    listQueuedMutations(userId).catch(() => queued),
    listPendingPlaybackActions(userId).catch(() => actions),
  ]);
  return [
    ...remainingQueued.map((mutation) => ({
      kind: mutation.kind,
      entityId: mutation.entityId,
      queuedAt: mutation.queuedAt,
    })),
    ...remainingActions.map((action) => ({
      kind: "playback-action" as const,
      entityId: action.bookId,
      queuedAt: Date.parse(action.occurredAt) || 0,
    })),
  ];
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
 *
 * No drain runs here, and none may: the session that is now open belongs to the
 * INCOMING account, so replaying a departed account's queue would post one
 * user's writes into another user's library.
 */
export async function purgeOnSignIn(incomingUserId: string): Promise<string[]> {
  const { users, failures } = await enumerateLocalUsers();
  const stale = users.filter((userId) => userId !== incomingUserId);
  const active = typeof localStorage === "undefined" ? null : localStorage.getItem(ACTIVE_USER_KEY);
  if (active && active !== incomingUserId && !stale.includes(active)) stale.push(active);
  const results = await Promise.allSettled(stale.map((userId) => purgeAccount(userId)));
  await purgeCachedPages().catch(() => undefined);
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw asPurgeFailure("the sign-in sweep", failures);
  return stale;
}
