import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

/**
 * The sign-out hook's ORDERING — `docs/local-first.md` section 11.
 *
 * The purge itself is proved in `offline/account-purge.test.ts` against real
 * IndexedDB. What is proved here is the thing that test could never see: that
 * the auth client does not hand control back to its caller until the sweep has
 * run, and that the outbox is drained on the way OUT rather than on the way
 * back, while the session cookie the replay needs is still valid.
 *
 * The purge module is replaced so the sequence is observable. Fire-and-forget
 * looks identical to awaited when every step is a resolved promise; each step
 * here takes a real macrotask, which is what makes the difference visible.
 */

const purge = vi.hoisted(() => ({
  order: [] as string[],
  undelivered: [] as Array<{ kind: string; entityId: string; queuedAt: number }>,
  failure: null as unknown,
}));

vi.mock("@/lib/offline/account-purge", () => ({
  drainBeforeSignOut: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push("drained");
    return purge.undelivered;
  },
  // Echoes `alreadyDrained` back, which is how the test sees that the drain's
  // result was handed to the purge rather than merged behind its back — and
  // that the purge is not asked to drain a second time against a dead session.
  purgeOnSignOut: async (
    _userId: string,
    options?: { alreadyDrained?: Array<{ kind: string; entityId: string; queuedAt: number }> },
  ) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push(options?.alreadyDrained ? "purged" : "purged-without-a-drain");
    return { undelivered: options?.alreadyDrained ?? [], failure: purge.failure };
  },
  purgeOnSignIn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    purge.order.push("purged-on-sign-in");
    return [];
  },
  purgeCachedPages: async () => {
    purge.order.push("pages-only");
  },
}));

const SIGN_OUT = "https://hark.test/api/auth/sign-out";
const USER_A = "user-a";

function fakeLocalStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

let storage: ReturnType<typeof fakeLocalStorage>;

beforeEach(async () => {
  purge.order = [];
  purge.undelivered = [];
  purge.failure = null;
  storage = fakeLocalStorage();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("localStorage", storage);
  // Drain any report a previous test left behind.
  const { takeSignOutReport } = await import("@/lib/auth-client");
  takeSignOutReport();
});

async function signOutThroughHooks(): Promise<void> {
  const { authFetchHooks } = await import("@/lib/auth-client");
  await authFetchHooks.onRequest({ url: SIGN_OUT, method: "POST" });
  await authFetchHooks.onSuccess({ request: { url: SIGN_OUT } });
}

describe("sign-out hooks", () => {
  it("drains before the request and does not return until the purge has run", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);

    await signOutThroughHooks();
    purge.order.push("sign-out-returned");

    expect(
      purge.order,
      "the caller regained control while the account's data was still on the device",
    ).toStrictEqual(["drained", "purged", "sign-out-returned"]);
  });

  it("reports writes the drain could not deliver to whoever signed out", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.undelivered = [{ kind: "metadata", entityId: "book", queuedAt: 1 }];

    await signOutThroughHooks();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    const report = takeSignOutReport();
    expect(report?.undelivered).toStrictEqual([
      { kind: "metadata", entityId: "book", queuedAt: 1 },
    ]);
    expect(report?.purgeFailed).toBe(false);
  });

  it("reports a purge that failed without failing the sign-out", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.failure = new Error("Cache Storage is unavailable");

    await expect(signOutThroughHooks()).resolves.toBeUndefined();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    expect(takeSignOutReport()?.purgeFailed).toBe(true);
  });

  it("consumes the report, so the same warning cannot be shown twice", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    purge.undelivered = [{ kind: "tag", entityId: "book", queuedAt: 1 }];

    await signOutThroughHooks();

    const { takeSignOutReport } = await import("@/lib/auth-client");
    expect(takeSignOutReport()?.undelivered.length).toBe(1);
    expect(takeSignOutReport()).toBe(null);
  });

  it("sweeps the page cache when no account was recorded on this device", async () => {
    await signOutThroughHooks();

    expect(purge.order).toStrictEqual(["pages-only"]);
  });

  it("does not drain on a sign-in, where the open session belongs to somebody else", async () => {
    storage.setItem(ACTIVE_USER_KEY, USER_A);
    const { authFetchHooks, whenAccountPurgeSettled } = await import("@/lib/auth-client");
    const url = "https://hark.test/api/auth/sign-in/email";

    await authFetchHooks.onRequest({ url, method: "POST" });
    await authFetchHooks.onSuccess({ request: { url }, data: { user: { id: "user-b" } } });
    await whenAccountPurgeSettled();

    expect(purge.order).toStrictEqual(["purged-on-sign-in"]);
  });
});
