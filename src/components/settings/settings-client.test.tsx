// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, expect, it, vi } from "vitest";

import { SettingsClient } from "./settings-client";

/**
 * Deleting your account must take your data off this device too.
 *
 * `/api/account/delete` ends the session on the server, so none of the auth
 * client's sign-out hooks fire on this path — no drain, no sweep. This
 * component is the only place the local purge can be asked for, and it used to
 * ask for `clearLocalDataForUser`, which covers downloads, transcripts and
 * cache entries and nothing else. The mirror it left behind is the whole
 * library: every book row, chapter, tag, collection and saved position, sitting
 * readable in IndexedDB under a user id whose account no longer exists.
 *
 * So the assertion is deliberately about WHICH sweep is called, not about the
 * observable end state. `purgeAccount` is covered in depth by
 * `src/lib/offline/account-purge.test.ts`; what was broken here, and what can
 * silently break again, is this call site choosing the smaller one.
 */

const EMAIL = "owner@hark.test";
const USER_ID = "user-settings-1";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const purge = vi.hoisted(() => ({ purgeAccount: vi.fn(async () => undefined) }));
const smallerSweep = vi.hoisted(() => ({ clearLocalDataForUser: vi.fn(async () => undefined) }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/offline/account-purge", () => purge);
vi.mock("@/lib/offline/library", () => smallerSweep);
vi.mock("@/components/player/playback-provider", () => ({
  usePlayback: () => ({ userId: USER_ID }),
}));
vi.mock("@/components/player/preferences-provider", () => ({
  usePreferences: () => ({
    preferences: { skipBackMs: 15_000, skipForwardMs: 30_000 },
    updatePreferences: vi.fn(),
  }),
}));

beforeEach(() => {
  // Vitest runs without globals, so testing-library's automatic cleanup hook
  // never registers; without this every render stacks up in one document.
  cleanup();
  router.replace.mockClear();
  purge.purgeAccount.mockClear();
  smallerSweep.clearLocalDataForUser.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

async function deleteAccount(): Promise<void> {
  render(<SettingsClient email={EMAIL} />);
  fireEvent.change(screen.getByLabelText(/type your email to confirm/i), {
    target: { value: EMAIL },
  });
  fireEvent.change(screen.getByLabelText(/current password/i), {
    target: { value: "a-real-password" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /delete my account/i }));
  });
}

it("sweeps the whole account off the device, not only the audio", async () => {
  await deleteAccount();

  expect(
    purge.purgeAccount,
    "deleting the account left the local mirror behind: every book, chapter, tag and position " +
      "the account had is still readable on this device",
  ).toHaveBeenCalledWith(USER_ID);
  expect(router.replace).toHaveBeenCalledWith("/register");
});

it("does not report success when the device could not be cleared", async () => {
  purge.purgeAccount.mockRejectedValueOnce(new Error("storage unavailable"));

  await deleteAccount();

  expect(screen.getByText(/could not clear every local file/i)).toBeInTheDocument();
  expect(
    router.replace,
    "the user was sent away as though the device were clean when it is not",
  ).not.toHaveBeenCalled();
});
