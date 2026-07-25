import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  drainOutbox,
  goOffline,
  goOnline,
  mirror,
  observedConflicts,
  openDevice,
  outbox,
  pull,
  replay,
  resetAccount,
  sharedSession,
  sql,
  watchConflicts,
  type Account,
  type StorageState,
} from "./harness/app";
import { readBookIds } from "./harness/state";

/**
 * Concurrent progress from two devices, resolved by the rules that already
 * exist.
 *
 * This file invents nothing. It asserts the behaviour encoded in
 * `src/server/playback/progress-policy.ts` (`decideProgressUpdate`: an event
 * more than `ORDERING_TOLERANCE_MS` older than the stored one is `stale-event`
 * and answered 409, and the stored state is kept) and in
 * `src/server/playback/progress.ts` (`playback_device_sequences` is a per-device
 * high-water mark, so a replayed sequence is a no-op rather than a second
 * apply), plus the client half in `offline-sync.ts#reconcileProgressConflict`
 * and the `PROGRESS_CONFLICT_EVENT` channel design contract section 7 names.
 */

const DURATION_MS = 600_000;
/** `ORDERING_TOLERANCE_MS` in `progress-policy.ts` is 2s; step well past it. */
const STALE_BY_MS = 120_000;
const DEVICE_A = "device-a-conflict-0001";
const DEVICE_B = "device-b-conflict-0002";

let session: { account: Account; storageState: StorageState } | null = null;

test.afterAll(async () => {
  await closeSql();
});

function importPayload(fingerprint: string) {
  return {
    fileName: encodeURIComponent("conflict.mp3"),
    byteSize: 2_097_152,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title: "Conflict Subject",
    author: "Conflict Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "Only", startMs: 0, endMs: DURATION_MS }],
  };
}

type Device = { context: BrowserContext; page: Page };

async function bringUp(
  browser: Parameters<typeof openDevice>[0],
  account: Account,
  storageState: StorageState,
  deviceId: string,
): Promise<Device> {
  const { context, page } = await openDevice(browser, deviceId, storageState);
  await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await attachDriver(page, account, deviceId);
  await watchConflicts(page);
  return { context, page };
}

async function serverState(bookId: string) {
  const [row] = await sql()<
    {
      position_ms: string;
      completed: boolean;
      device_id: string;
      device_sequence: string;
      event_occurred_at: Date;
    }[]
  >`
    SELECT position_ms, completed, device_id, device_sequence, event_occurred_at
    FROM playback_states WHERE book_id = ${bookId}::uuid
  `;
  return row
    ? {
        positionMs: Number(row.position_ms),
        completed: row.completed,
        deviceId: row.device_id,
        deviceSequence: Number(row.device_sequence),
        eventOccurredAt: row.event_occurred_at.toISOString(),
      }
    : null;
}

async function setUp(browser: Parameters<typeof openDevice>[0]) {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);
  const a = await bringUp(browser, account, storageState, DEVICE_A);
  const b = await bringUp(browser, account, storageState, DEVICE_B);

  const fingerprint = "b".repeat(63) + "1";
  await commit(a.page, { kind: "import", fingerprint, payload: importPayload(fingerprint) });
  await drainOutbox(a.page);
  const bookId = (await readBookIds(account.userId)).get(fingerprint);
  expect(bookId, "the conflict subject never reached the server").toBeTruthy();
  expect(await pull(a.page)).toBe("applied");
  expect(await pull(b.page)).toBe("applied");
  return { account, a, b, bookId: bookId!, fingerprint };
}

test("the older event loses, the server keeps the newer one, and the conflict is surfaced", async ({
  browser,
}) => {
  const { a, b, bookId } = await setUp(browser);
  try {
    const now = Date.now();

    // Device A listens and its position lands.
    await commit(a.page, {
      kind: "progress",
      bookId,
      positionMs: 240_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date(now).toISOString(),
    });
    await drainOutbox(a.page);
    const afterA = await serverState(bookId);
    expect(afterA?.positionMs, "device A's progress never reached the server").toBe(240_000);
    expect(afterA?.deviceId).toBe(DEVICE_A);

    // Device B was offline and its event genuinely happened two minutes EARLIER.
    await goOffline(b.context, b.page);
    await commit(b.page, {
      kind: "progress",
      bookId,
      positionMs: 15_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date(now - STALE_BY_MS).toISOString(),
    });
    expect(
      (await outbox(b.page)).map((row) => row.kind),
      "device B's progress was not queued while it was offline",
    ).toStrictEqual(["progress"]);
    await goOnline(b.context, b.page);
    await replay(b.page);

    const afterB = await serverState(bookId);
    expect(
      afterB,
      "the stale event from device B overwrote the newer position from device A. " +
        "`decideProgressUpdate` classifies it as `stale-event` and the server must keep the " +
        "state it already had.",
    ).toMatchObject({ positionMs: 240_000, deviceId: DEVICE_A });

    // 409 is not a retry and not a terminal drop: it is reconciliation, and the
    // row must leave the queue rather than replay forever.
    expect(
      await outbox(b.page),
      "the conflicting mutation is still queued, so device B will re-send it forever",
    ).toStrictEqual([]);

    // Design contract section 7: conflicts surface through the existing
    // PROGRESS_CONFLICT_EVENT, not a parallel channel.
    await expect
      .poll(() => observedConflicts(b.page), {
        message:
          "device B's 409 did not raise PROGRESS_CONFLICT_EVENT, so the user is never told " +
          "their position was overruled",
        timeout: 10_000,
      })
      .toHaveLength(1);
    expect((await observedConflicts(b.page))[0]).toMatchObject({
      bookId,
      positionMs: 240_000,
      completed: false,
    });

    // And after a pull both devices agree with the server.
    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");
    for (const [label, device] of [
      ["A", a],
      ["B", b],
    ] as const) {
      const state = (await mirror(device.page)).playbackStates.find((row) => row.bookId === bookId);
      expect(state?.positionMs, `device ${label} did not converge on the winning position`).toBe(
        240_000,
      );
    }
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("the newer event from the other device wins and both devices converge on it", async ({
  browser,
}) => {
  const { a, b, bookId } = await setUp(browser);
  try {
    const now = Date.now();
    await commit(a.page, {
      kind: "progress",
      bookId,
      positionMs: 100_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date(now - STALE_BY_MS).toISOString(),
    });
    await drainOutbox(a.page);
    expect((await serverState(bookId))?.positionMs).toBe(100_000);

    await commit(b.page, {
      kind: "progress",
      bookId,
      positionMs: 410_000,
      playbackRate: 1.5,
      completed: false,
      eventOccurredAt: new Date(now).toISOString(),
    });
    await drainOutbox(b.page);

    const resolved = await serverState(bookId);
    expect(
      resolved,
      "the newer event from device B did not win, although its eventOccurredAt is later",
    ).toMatchObject({ positionMs: 410_000, deviceId: DEVICE_B });
    // Sequences are per device, so B's first write is sequence 1 and must not
    // be judged against A's.
    expect(resolved?.deviceSequence).toBe(1);

    expect(await pull(a.page)).toBe("applied");
    expect(await pull(b.page)).toBe("applied");
    const positions = await Promise.all(
      [a, b].map(
        async (device) =>
          (await mirror(device.page)).playbackStates.find((row) => row.bookId === bookId)
            ?.positionMs,
      ),
    );
    expect(positions, "the two devices did not converge on the winner").toStrictEqual([
      410_000, 410_000,
    ]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("progress coalesces to the highest device sequence and replay stays idempotent", async ({
  browser,
}) => {
  const { a, b, bookId } = await setUp(browser);
  try {
    const now = Date.now();
    await goOffline(a.context, a.page);
    // Two heartbeats for the same book on the same device while offline. The
    // coalescing policy for `progress` is `sequence`, so exactly one row must
    // survive and it must be the later one — that is the design contract's
    // stated behaviour, not a lost write.
    await commit(a.page, {
      kind: "progress",
      bookId,
      positionMs: 30_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date(now).toISOString(),
    });
    await commit(a.page, {
      kind: "progress",
      bookId,
      positionMs: 90_000,
      playbackRate: 1,
      completed: false,
      eventOccurredAt: new Date(now + 1_000).toISOString(),
    });
    const queued = await outbox(a.page);
    expect(queued, "the two heartbeats did not coalesce to one row").toHaveLength(1);
    expect(queued[0]?.payload.positionMs, "coalescing kept the OLDER heartbeat").toBe(90_000);
    expect(queued[0]?.deviceSequence).toBe(2);

    await goOnline(a.context, a.page);
    await drainOutbox(a.page);
    expect((await serverState(bookId))?.positionMs).toBe(90_000);
    expect((await serverState(bookId))?.deviceSequence).toBe(2);

    // Replaying an empty queue, and then re-running a full drain, must not move
    // anything: `mutationId` is minted once and the server dedupes on it.
    await replay(a.page);
    await drainOutbox(a.page);
    expect(
      (await serverState(bookId))?.positionMs,
      "a second replay pass changed the stored position, so replay is not idempotent",
    ).toBe(90_000);
    expect(await outbox(a.page)).toStrictEqual([]);
    void b;
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
