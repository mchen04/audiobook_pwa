// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryClient } from "./library-client";

/**
 * The one library UI answers two URLs.
 *
 * When the service worker cannot fetch `/books/:id` it serves the cached
 * library document instead, and this component reads the book id out of the
 * URL and plays this device's own copy. That makes the URL — not a click — the
 * thing that decides whether the player or the grid is on screen, so every way
 * the URL can change has to be honoured. The browser's back button changes it
 * without a click, and `AppShell` and `MiniPlayer` both already follow it via
 * `usePathname()`; a component that read the URL only at mount would leave the
 * player mounted under a header that had already returned to library chrome.
 */

const BOOK_ID = "11111111-2222-3333-4444-555555555555";

const device = new Map([[BOOK_ID, { book: { id: BOOK_ID, title: "The Hobbit" } }]]);

vi.mock("@/components/use-active-user", () => ({ useActiveUserId: () => "user-1" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/player/full-player", () => ({
  FullPlayer: ({ onBack, backLabel }: { onBack?: () => void; backLabel?: string }) => (
    <div>
      <span>Now playing</span>
      <button type="button" onClick={onBack}>
        {backLabel}
      </button>
    </div>
  ),
}));
vi.mock("@/lib/offline/library", () => ({ asOfflinePlayerBook: (record: unknown) => record }));
vi.mock("@/lib/offline/transcript-store", () => ({
  listBookIdsWithTranscripts: async () => new Set<string>(),
}));
vi.mock("@/lib/local-import", () => ({ importLocalMp3: async () => undefined }));
vi.mock("@/lib/launch-revalidation", () => ({ markLaunchPainted: () => undefined }));
vi.mock("./use-library-books", () => ({
  useLibraryBooks: () => ({
    snapshot: {
      books: [],
      device,
      libraryTotal: 1,
      tags: [],
      continueBook: null,
    },
    preparing: false,
    firstSyncStatus: "done",
    unavailable: false,
    reload: async () => undefined,
    retry: () => undefined,
    removeDownload: async () => true,
  }),
}));

function goTo(path: string) {
  window.history.replaceState(null, "", path);
}

/** What a back button does, as this document observes it: the URL, then the event. */
function popTo(path: string) {
  act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

function setReferrer(value: string) {
  Object.defineProperty(document, "referrer", { configurable: true, value });
}

beforeEach(() => {
  goTo("/library");
  setReferrer("");
});

afterEach(cleanup);

describe("LibraryClient URL following", () => {
  it("plays the book the document was opened at", () => {
    goTo(`/books/${BOOK_ID}`);
    render(<LibraryClient />);
    expect(screen.getByText("Now playing")).toBeInTheDocument();
  });

  it("returns to the library when the back button leaves the book URL", () => {
    goTo(`/books/${BOOK_ID}`);
    render(<LibraryClient />);
    expect(screen.getByText("Now playing")).toBeInTheDocument();

    popTo("/library");

    expect(screen.queryByText("Now playing")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
  });

  it("plays the book a back button lands ON", () => {
    render(<LibraryClient />);
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();

    popTo(`/books/${BOOK_ID}`);

    expect(screen.getByText("Now playing")).toBeInTheDocument();
  });

  it("pops the player's history entry when the app is what opened it", () => {
    setReferrer(`${window.location.origin}/library`);
    goTo(`/books/${BOOK_ID}`);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    render(<LibraryClient />);

    act(() => {
      screen.getByRole("button", { name: "Library" }).click();
    });

    // Popped, not overwritten: the book stays ahead in history, forward works,
    // and this button and the system back button agree on where the library is.
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it("rewrites the URL in place when there is nothing to go back to", () => {
    setReferrer("");
    goTo(`/books/${BOOK_ID}`);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    render(<LibraryClient />);

    act(() => {
      screen.getByRole("button", { name: "Library" }).click();
    });

    // A document opened cold at a book URL has only the browser behind it, so
    // going back would walk the user out of the app entirely.
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/library");
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
    back.mockRestore();
  });
});
