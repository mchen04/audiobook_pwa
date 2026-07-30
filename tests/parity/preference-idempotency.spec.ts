import { expect, test, type Page } from "@playwright/test";

import {
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_LEGACY_REPLAY_HEADER,
  PREFERENCES_WRITE_ID_HEADER,
} from "../../src/lib/preferences";
import {
  ACCOUNT_A,
  ensureAccount,
  network,
  openDevice,
  resetAccount,
  signInThroughUi,
  sql,
  type Account,
  type Device,
} from "./harness/app";

const WRITE_A = "79f32bc7-d0c8-4b51-8d5f-e1399cf57fa1";
const WRITE_B = "f79ed93c-9d60-4c17-a5b8-f2cd3f690dda";
const LEGACY_WRITE = "11266fe2-ee8d-4970-8945-b3883666b97a";
const SESSION_LOCK_SETUP = "3c398f26-983d-4826-9676-e2d867043621";
const SESSION_LOCK_OLD = "d21b4e87-265f-43a1-a205-50100779d3e2";
const SESSION_LOCK_NEW = "83730691-684c-4e5e-bff8-122029af4c1b";

let account: Account;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  account = await ensureAccount(browser, ACCOUNT_A);
});

test.afterAll(async () => {
  (await network()).restore();
});

test("a lost response retry cannot overwrite a newer preference from another device", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(account.userId);
  const device: Device = await openDevice(browser, {
    deviceId: "preference-receipt-device-1",
  });
  try {
    await signInThroughUi(device.page, account);

    const incomplete = await device.page.evaluate(async () => {
      const response = await fetch("/api/preferences/v2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipBackMs: 60_000 }),
      });
      return response.status;
    });
    expect(incomplete, "the rollout-fenced endpoint accepted an unreceipted write").toBe(400);

    const first = await patchPreference(device.page, WRITE_A, 45_000);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      acknowledgedWriteId: WRITE_A,
      acknowledgedPatch: { skipBackMs: 45_000 },
    });

    // Device B changes the same field after A committed. A never saw its
    // response, so its next reconnect sends the exact same write id again.
    expect((await patchPreference(device.page, WRITE_B, 10_000)).status).toBe(200);
    const replay = await patchPreference(device.page, WRITE_A, 45_000);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      preferences: { skipBackMs: 10_000 },
      acknowledgedWriteId: WRITE_A,
      acknowledgedPatch: { skipBackMs: 45_000 },
    });

    const current = await device.page.evaluate(async () => {
      const response = await fetch("/api/preferences", { cache: "no-store" });
      return response.json() as Promise<{ preferences: { skipBackMs: number } }>;
    });
    expect(current.preferences.skipBackMs).toBe(10_000);

    const [receiptCount] = await sql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM preference_write_receipts
      WHERE user_id = ${account.userId}
    `;
    expect(receiptCount?.count).toBe(2);
  } finally {
    await device.context.close();
  }
});

test("a migrated legacy retry is receipted and cannot overwrite a newer device", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(account.userId);
  const device: Device = await openDevice(browser, {
    deviceId: "legacy-preference-receipt-device-1",
  });
  try {
    await signInThroughUi(device.page, account);

    const legacyBody = {
      skipBackMs: 45_000,
      skipForwardMs: 30_000,
      smartRewind: true,
      autoplayNextInCollection: false,
    };
    expect((await patchLegacyPreference(device.page, LEGACY_WRITE, legacyBody)).status).toBe(200);
    expect((await patchPreference(device.page, WRITE_B, 10_000)).status).toBe(200);

    const replay = await patchLegacyPreference(device.page, LEGACY_WRITE, legacyBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      preferences: { skipBackMs: 10_000, smartRewind: false },
      acknowledgedWriteId: LEGACY_WRITE,
      acknowledgedPatch: legacyBody,
    });

    const [receiptCount] = await sql()<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM preference_write_receipts
      WHERE user_id = ${account.userId}
    `;
    expect(receiptCount?.count).toBe(2);
  } finally {
    await device.context.close();
  }
});

test("sign-out cannot finish while an authorized preference transaction is still live", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await resetAccount(account.userId);
  const device: Device = await openDevice(browser, {
    deviceId: "preference-session-lock-device-1",
  });
  try {
    await signInThroughUi(device.page, account);
    expect((await patchPreference(device.page, SESSION_LOCK_SETUP, 15_000)).status).toBe(200);

    const blocker = await sql().reserve();
    let transactionOpen = false;
    let oldWrite: ReturnType<typeof patchPreference> | null = null;
    let signOut: Promise<number> | null = null;
    try {
      await blocker`BEGIN`;
      transactionOpen = true;
      await blocker`
        SELECT user_id
        FROM user_preferences
        WHERE user_id = ${account.userId}
        FOR UPDATE
      `;

      oldWrite = patchPreference(device.page, SESSION_LOCK_OLD, 45_000);
      await expect
        .poll(() => blockedQueryCount("user_preferences"), {
          timeout: 20_000,
          message: "the old preference request never reached its blocked database update",
        })
        .toBeGreaterThan(0);

      signOut = rawSignOut(device.page);
      await expect
        .poll(() => blockedSessionDeleteCount(), {
          timeout: 20_000,
          message: "sign-out deleted the authorizing session instead of waiting for its live write",
        })
        .toBeGreaterThan(0);
    } finally {
      if (transactionOpen) await blocker`ROLLBACK`;
      blocker.release();
    }

    expect((await oldWrite!).status).toBe(200);
    expect(await signOut!).toBeLessThan(400);

    await signInThroughUi(device.page, account);
    expect((await patchPreference(device.page, SESSION_LOCK_NEW, 10_000)).status).toBe(200);
    const current = await readPreferences(device.page);
    expect(current.skipBackMs).toBe(10_000);
  } finally {
    await device.context.close();
  }
});

async function patchPreference(
  page: Page,
  writeId: string,
  skipBackMs: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ id, value, defaultsHeader, defaultsVersion, writeIdHeader }) => {
      const response = await fetch("/api/preferences/v2", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          [defaultsHeader]: String(defaultsVersion),
          [writeIdHeader]: id,
        },
        body: JSON.stringify({ skipBackMs: value }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    {
      id: writeId,
      value: skipBackMs,
      defaultsHeader: PREFERENCES_DEFAULTS_HEADER,
      defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
      writeIdHeader: PREFERENCES_WRITE_ID_HEADER,
    },
  );
}

async function rawSignOut(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return response.status;
  });
}

async function blockedQueryCount(fragment: string): Promise<number> {
  const [row] = await sql()<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'
      AND query ILIKE ${`%${fragment}%`}
  `;
  return row?.count ?? 0;
}

async function blockedSessionDeleteCount(): Promise<number> {
  const [row] = await sql()<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'
      AND query ~* 'delete.+session'
  `;
  return row?.count ?? 0;
}

async function readPreferences(page: Page): Promise<{ skipBackMs: number }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/preferences", { cache: "no-store" });
    const body = (await response.json()) as { preferences: { skipBackMs: number } };
    return body.preferences;
  });
}

async function patchLegacyPreference(
  page: Page,
  writeId: string,
  body: {
    skipBackMs: number;
    skipForwardMs: number;
    smartRewind: boolean;
    autoplayNextInCollection: boolean;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ id, patch, replayHeader, writeIdHeader }) => {
      const response = await fetch("/api/preferences/v2", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          [replayHeader]: "1",
          [writeIdHeader]: id,
        },
        body: JSON.stringify(patch),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    {
      id: writeId,
      patch: body,
      replayHeader: PREFERENCES_LEGACY_REPLAY_HEADER,
      writeIdHeader: PREFERENCES_WRITE_ID_HEADER,
    },
  );
}
