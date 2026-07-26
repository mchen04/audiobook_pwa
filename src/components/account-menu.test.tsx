// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_USER_KEY } from "@/lib/app-keys";

import { AccountMenu } from "./account-menu";

/**
 * The sign-out call site — `docs/local-first.md` section 11.
 *
 * Two properties, both of which this component got wrong:
 *
 *  1. It must NOT clear `chapterline:active-user` itself. That key is the only
 *     record of whose data is on this device, and the purge reads it. Clearing
 *     it here raced the purge across a dynamic import and won, and the purge
 *     then read `null` and swept nothing but the page cache.
 *  2. It must not walk away from a write that never reached the server. Sign-out
 *     removes the account from the device, so an undelivered write is gone; the
 *     one thing that must never happen is losing it silently.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const auth = vi.hoisted(() => ({
  signOut: vi.fn(async () => undefined),
  report: null as unknown,
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: auth.signOut },
  takeSignOutReport: () => {
    const report = auth.report;
    auth.report = null;
    return report;
  },
}));

beforeEach(() => {
  // Vitest runs without globals, so testing-library's automatic cleanup hook
  // never registers; without this every render stacks up in one document.
  cleanup();
  router.replace.mockClear();
  router.refresh.mockClear();
  auth.signOut.mockClear();
  auth.report = null;
  localStorage.clear();
});

async function clickSignOut(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
  });
}

describe("account menu sign-out", () => {
  it("leaves the active-user key for the purge to own", async () => {
    localStorage.setItem(ACTIVE_USER_KEY, "user-a");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    expect(
      removeItem.mock.calls.map(([key]) => key),
      "the sign-out call site cleared the key the purge needs to read",
    ).not.toContain(ACTIVE_USER_KEY);
    expect(router.replace).toHaveBeenCalledWith("/login");
    removeItem.mockRestore();
  });

  it("tells the user about writes that never reached the server, and stays put", async () => {
    auth.report = {
      undelivered: [
        { kind: "metadata", entityId: "book-1", queuedAt: 1 },
        { kind: "tag", entityId: "book-2", queuedAt: 2 },
      ],
      purgeFailed: false,
    };
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("2 changes");
    expect(alert).toHaveTextContent("1 metadata, 1 tag");
    expect(
      router.replace,
      "the user was navigated away before they could read what they lost",
    ).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue to sign-in" }));
    });
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("says so when the device could not be fully swept", async () => {
    auth.report = { undelivered: [], purgeFailed: true };
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    expect(screen.getByRole("alert")).toHaveTextContent(/could not be removed from this device/);
  });

  it("goes straight to the login page when everything was delivered", async () => {
    auth.report = { undelivered: [], purgeFailed: false };
    render(<AccountMenu email="a@hark.test" />);

    await clickSignOut();

    expect(router.replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
