import { expect, test } from "@playwright/test";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  drainOutbox,
  goOffline,
  goOnline,
  openDevice,
  outbox,
  resetAccount,
  sharedSession,
  sql,
  type Account,
} from "./harness/app";
import { readBookIds, readServerState } from "./harness/state";

/**
 * Design contract section 5, rule 3: coalescing happens by `key`, and only
 * where it is safe.
 *
 * `import`, `delete` and `history` are distinct events. Collapsing two of them
 * is not a saved round trip, it is a user write that no longer exists anywhere
 * — the outbox is the only record of it. The enforcement is that
 * `eventMutationKey` puts the `mutationId` in the key, so two of them can never
 * collide; this file asserts the OUTCOME of that rule rather than the shape of
 * the key, so any future change that reintroduces a collision is caught.
 *
 * Everything is queued in ONE offline window on purpose. Coalescing can only
 * happen while two rows are alive at the same time, so a test that drained
 * between mutations would prove nothing about the policy.
 */

const DEVICE = "device-coalesce-00001";
const DURATION_MS = 600_000;

let session: {
  account: Account;
  storageState: Awaited<ReturnType<typeof sharedSession>>["storageState"];
} | null = null;

test.afterAll(async () => {
  await closeSql();
});

function importPayload(fingerprint: string, title: string) {
  return {
    fileName: encodeURIComponent("coalesce.mp3"),
    byteSize: 1_048_576,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title,
    author: "Coalescing Author",
    narrator: null,
    chapterDiagnostic: null,
    chapters: [{ position: 0, title: "Only", startMs: 0, endMs: DURATION_MS }],
  };
}

function media(suffix: string): string {
  return suffix.padStart(64, "a").slice(-64);
}

test("distinct events never collapse, and replaceable ones collapse to the latest", async ({
  browser,
}) => {
  session ??= await sharedSession(browser);
  const { account, storageState } = session;
  await resetAccount(account.userId);

  const { context, page } = await openDevice(browser, DEVICE, storageState);
  try {
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, DEVICE);

    // Two books that already exist, so the offline window below can address them.
    const keeper = media("1111");
    const doomed = media("2222");
    await commit(page, {
      kind: "import",
      fingerprint: keeper,
      payload: importPayload(keeper, "Coalesce Keeper"),
    });
    await commit(page, {
      kind: "import",
      fingerprint: doomed,
      payload: importPayload(doomed, "Coalesce Doomed"),
    });
    await drainOutbox(page);
    const ids = await readBookIds(account.userId);
    const bookId = ids.get(keeper)!;
    const doomedId = ids.get(doomed)!;
    expect(bookId && doomedId, "the coalescing subjects never reached the server").toBeTruthy();

    // ------------------------------------------------- one offline window
    await goOffline(context, page);

    // `history` — three separate user actions on ONE book.
    const historyIds: string[] = [];
    for (const position of [10_000, 20_000, 30_000]) {
      const { mutationId } = await commit(page, {
        kind: "history",
        bookId,
        event: {
          action: "seek",
          positionMs: position,
          previousPositionMs: 0,
          playbackRate: 1,
          description: `seek to ${position}`,
          occurredAt: new Date().toISOString(),
        },
      });
      historyIds.push(mutationId);
    }

    // `import` — two new books queued together.
    const first = media("3333");
    const second = media("4444");
    await commit(page, {
      kind: "import",
      fingerprint: first,
      payload: importPayload(first, "Queued Import One"),
    });
    await commit(page, {
      kind: "import",
      fingerprint: second,
      payload: importPayload(second, "Queued Import Two"),
    });

    // `delete` — issued twice for the same book, which is two distinct events
    // even though the second is a no-op on the server.
    await commit(page, { kind: "delete", bookId: doomedId });
    await commit(page, { kind: "delete", bookId: doomedId });

    // `metadata` and `archive` — replaceable, so the latest intent wins.
    await commit(page, { kind: "rename", bookId, fields: { title: "First Rename" } });
    await commit(page, { kind: "rename", bookId, fields: { title: "Second Rename" } });
    await commit(page, { kind: "archive", bookId, archived: true });
    await commit(page, { kind: "archive", bookId, archived: false });

    const queued = await outbox(page);
    const byKind = new Map<string, number>();
    for (const row of queued) byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);

    expect(
      byKind.get("history"),
      "three separate seeks collapsed into fewer rows. `history` is listed as `never` in " +
        "MUTATION_COALESCING and each row is the only record of one user action.",
    ).toBe(3);
    expect(
      byKind.get("import"),
      "two imports collapsed. One of those books would never be registered at all.",
    ).toBe(2);
    expect(byKind.get("delete"), "two delete events collapsed").toBe(2);
    expect(byKind.get("metadata"), "two renames of one book did not collapse to one row").toBe(1);
    expect(byKind.get("archive"), "two archive flips on one book did not collapse to one row").toBe(
      1,
    );
    expect(
      queued.find((row) => row.kind === "metadata")?.payload.title,
      "coalescing kept the earlier rename",
    ).toBe("Second Rename");
    expect(
      queued.find((row) => row.kind === "archive")?.payload.archived,
      "coalescing kept the earlier archive flip",
    ).toBe(false);

    // ------------------------------------------------------- and delivered
    await goOnline(context, page);
    await drainOutbox(page);

    const server = await readServerState(account.userId);
    const actions = await sql()<{ id: string }[]>`
      SELECT id FROM playback_actions WHERE user_id = ${account.userId}
    `;
    expect(
      actions.map((row) => row.id).sort(),
      "not every seek reached the server, so a user action was lost between the queue and " +
        "Postgres",
    ).toStrictEqual([...historyIds].sort());
    expect(
      [...server.booksByFingerprint.keys()].sort(),
      "the books on the server do not match what the user imported and deleted",
    ).toStrictEqual([keeper, first, second].sort());
    expect(server.booksByFingerprint.get(keeper)).toMatchObject({
      title: "Second Rename",
      archived: false,
    });
  } finally {
    await context.close();
  }
});
