import type { Page } from "@playwright/test";

/**
 * What the library actually is at a moment in time: the URL it is on, every
 * control it offers, and the exact set of book cards it rendered — titles,
 * authors, tags, whether each one's audio is on this device, what it says about
 * that, and whether it offers a way to play.
 *
 * The parity gate compares two of these structurally. A count would pass while
 * the offline library showed a different six books; this cannot.
 */

export type BookCardSnapshot = {
  title: string;
  author: string;
  tags: string;
  /** The card's missing-audio sentence; empty when the audio IS on this device. */
  deviceLine: string;
  /** The card's meta-line size marker, e.g. "5.4 GB on this device". */
  deviceSize: string;
  onDevice: boolean;
  /** The "Not on device" badge over the cover. */
  offDeviceBadge: boolean;
  removeDownloadButton: boolean;
  /** A real `<a>` that opens the player — the only play affordance a card has. */
  playLink: boolean;
  /** The inert stand-in shown where a play link would be. */
  playUnavailable: boolean;
  progress: string;
};

export type LibrarySnapshot = {
  path: string;
  launchReady: string | null;
  heading: string | null;
  addButton: string | null;
  headerDownloadsHref: string | null;
  search: { present: boolean; label: string | null; placeholder: string | null; value: string };
  clearSearchButton: boolean;
  sort: { present: boolean; value: string; options: string[] };
  viewSwitch: { present: boolean; visible: boolean; buttons: string[]; pressed: string[] };
  statusChips: Array<{ label: string; pressed: boolean }>;
  deviceChip: { label: string; pressed: boolean; count: string | null } | null;
  tagChips: Array<{ label: string; pressed: boolean }>;
  listMode: boolean;
  continueCard: { title: string; meta: string; playable: boolean } | null;
  books: BookCardSnapshot[];
  noResults: { heading: string; body: string } | null;
  emptyLibrary: boolean;
  preparing: boolean;
};

export function readLibrary(page: Page): Promise<LibrarySnapshot> {
  return page.evaluate(() => {
    const text = (node: Element | null | undefined) => (node?.textContent ?? "").trim();
    const chip = (button: Element) => ({
      label: text(button),
      pressed: button.getAttribute("aria-pressed") === "true",
    });

    const content = document.querySelector("section.library-content, section.empty-library");
    const marker = document.querySelector("[data-launch-ready]");
    const searchInput = document.querySelector<HTMLInputElement>(
      ".search-field input[type=search]",
    );
    const sortSelect = document.querySelector<HTMLSelectElement>(".sort-field select");
    const viewSwitch = document.querySelector<HTMLElement>(".view-switch");
    const chips = [...document.querySelectorAll(".library-filters .filter-chip")];
    const deviceChipEl = document.querySelector(".filter-chip-device");
    const continueCard = document.querySelector(".continue-card");
    const noResults = document.querySelector(".no-results");

    return {
      path: window.location.pathname + window.location.search,
      launchReady: marker?.getAttribute("data-launch-ready") ?? null,
      heading: text(document.querySelector("#library-title")) || null,
      addButton: text(document.querySelector(".library-heading .primary-button")) || null,
      headerDownloadsHref:
        document.querySelector("header a[href^='/library?device=']")?.getAttribute("href") ?? null,
      search: {
        present: !!searchInput,
        label: text(document.querySelector(".search-field .visually-hidden")) || null,
        placeholder: searchInput?.placeholder ?? null,
        value: searchInput?.value ?? "",
      },
      clearSearchButton: !!document.querySelector(
        ".search-field button[aria-label='Clear search']",
      ),
      sort: {
        present: !!sortSelect,
        value: sortSelect?.value ?? "",
        options: [...(sortSelect?.options ?? [])].map(
          (option) => `${option.value}=${option.textContent?.trim()}`,
        ),
      },
      viewSwitch: {
        present: !!viewSwitch,
        visible: !!viewSwitch && getComputedStyle(viewSwitch).display !== "none",
        buttons: [...(viewSwitch?.querySelectorAll("button") ?? [])].map(
          (button) => button.getAttribute("aria-label") ?? "",
        ),
        pressed: [...(viewSwitch?.querySelectorAll("button") ?? [])]
          .filter((button) => button.getAttribute("aria-pressed") === "true")
          .map((button) => button.getAttribute("aria-label") ?? ""),
      },
      statusChips: chips
        .filter((button) => !button.classList.contains("filter-chip-device"))
        .filter((button) => !button.classList.contains("filter-chip-tag"))
        .map(chip),
      deviceChip: deviceChipEl
        ? {
            label: text(deviceChipEl.querySelector("span:not(.filter-chip-count)")),
            pressed: deviceChipEl.getAttribute("aria-pressed") === "true",
            count: text(deviceChipEl.querySelector(".filter-chip-count")) || null,
          }
        : null,
      tagChips: chips.filter((button) => button.classList.contains("filter-chip-tag")).map(chip),
      listMode: !!document.querySelector(".book-grid.book-grid-list"),
      continueCard: continueCard
        ? {
            title: text(continueCard.querySelector(".continue-copy strong")),
            meta: text(continueCard.querySelector(".continue-copy span")),
            playable: !continueCard.querySelector(".continue-unavailable"),
          }
        : null,
      books: [...document.querySelectorAll("article.book-item")].map((card) => ({
        title: text(card.querySelector(".book-title")),
        author: text(card.querySelector(".book-copy > p:not([class])")),
        tags: text(card.querySelector(".book-tags")),
        // Only a card whose audio is MISSING carries a device sentence now; a
        // card that has the audio states its size in the meta line instead.
        deviceLine: text(card.querySelector(".book-device")),
        deviceSize: text(card.querySelector(".book-device-size")),
        onDevice: !!card.querySelector(".book-device-size"),
        offDeviceBadge: !!card.querySelector(".book-offdevice"),
        removeDownloadButton: !!card.querySelector(".book-device-remove"),
        playLink: !!card.querySelector("a.book-play-button"),
        playUnavailable: !!card.querySelector("span.book-play-unavailable"),
        progress: text(card.querySelector(".book-progress-status")),
      })),
      noResults: noResults
        ? {
            heading: text(noResults.querySelector("h2")),
            body: text(noResults.querySelector("p")),
          }
        : null,
      emptyLibrary: !!document.querySelector("section.empty-library"),
      preparing: content?.getAttribute("aria-busy") === "true" && !marker,
    };
  });
}

/** Titles in the order the grid rendered them. */
export function titlesOf(snapshot: LibrarySnapshot): string[] {
  return snapshot.books.map((book) => book.title);
}

// ---------------------------------------------------------------------------
// Device storage, read raw
// ---------------------------------------------------------------------------

export type StoreDump = {
  count: number;
  keys: string[];
  /** Records whose own `userId` field (or key prefix) names this account. */
  ownedByTarget: number;
  /** Records whose serialized form mentions the account id ANYWHERE. */
  mentionsTarget: number;
};

export type DeviceStorage = {
  databases: string[];
  stores: Record<string, StoreDump>;
  caches: Record<string, string[]>;
  /** Cached shell documents whose BYTES name the account, not merely their URL. */
  shellBodiesMentioningTarget: string[];
  localStorageKeys: string[];
  localStorageMentioningTarget: string[];
  activeUser: string | null;
};

/**
 * Every object store of both IndexedDB databases, every Cache Storage entry,
 * and every localStorage key — read with plain platform APIs rather than
 * through the app's own accessors.
 *
 * That choice is the whole point. A purge verifier that asked the app which
 * stores exist would be asking the code under test to enumerate the stores it
 * might have forgotten. This enumerates them from the database itself, so a
 * store the purge skips is still counted.
 */
export function readDeviceStorage(
  page: Page,
  targetUserId: string,
  targetEmail?: string,
): Promise<DeviceStorage> {
  return page.evaluate(
    async ([userId, email]) => {
      const openExisting = (name: string) =>
        new Promise<IDBDatabase | null>((resolve) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        });

      const all = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

      const safeStringify = (value: unknown): string => {
        try {
          return JSON.stringify(value, (_key, inner) => {
            if (inner instanceof ArrayBuffer) return "[ArrayBuffer]";
            if (typeof Blob !== "undefined" && inner instanceof Blob) return "[Blob]";
            return inner as unknown;
          });
        } catch {
          return String(value);
        }
      };

      // Every database this app writes user data into. `hark-playback-history-v1`
      // is easy to forget — it is opened by a lazily-imported module and named
      // nothing like the others — and it holds one row per play, pause and seek.
      const known = ["chapterline-offline-v1", "chapterline-sync-v1", "hark-playback-history-v1"];
      const names = ((await indexedDB.databases?.()) ?? []).map((entry) => entry.name ?? "");
      const databases = [...new Set([...names.filter(Boolean), ...known])].filter((name) =>
        known.includes(name),
      );

      const stores: Record<
        string,
        { count: number; keys: string[]; ownedByTarget: number; mentionsTarget: number }
      > = {};

      for (const name of databases) {
        const db = await openExisting(name);
        if (!db) continue;
        const storeNames = [...db.objectStoreNames];
        if (!storeNames.length) {
          db.close();
          continue;
        }
        const transaction = db.transaction(storeNames, "readonly");
        for (const storeName of storeNames) {
          const store = transaction.objectStore(storeName);
          const [records, keys] = await Promise.all([all(store.getAll()), all(store.getAllKeys())]);
          let ownedByTarget = 0;
          let mentionsTarget = 0;
          for (let index = 0; index < records.length; index += 1) {
            const record = records[index] as Record<string, unknown> | undefined;
            const key = keys[index];
            const owner =
              typeof record?.userId === "string"
                ? record.userId
                : typeof key === "string"
                  ? key.split(":")[0]
                  : null;
            if (owner === userId) ownedByTarget += 1;
            if (safeStringify(record).includes(userId) || String(key).includes(userId)) {
              mentionsTarget += 1;
            }
          }
          stores[`${name}/${storeName}`] = {
            count: records.length,
            keys: keys.map((key) => String(key)),
            ownedByTarget,
            mentionsTarget,
          };
        }
        db.close();
      }

      const cacheDump: Record<string, string[]> = {};
      // Any cached DOCUMENT whose bytes name the departing account. Allowlisting
      // a shell page by pathname only ever asserted which URL survived, never
      // what was in it — so this reads the bodies of every surviving shell entry
      // and looks for the account. That is the property section 11 actually
      // promises, and it is what makes keeping a page defensible rather than
      // merely permitted.
      const shellBodiesMentioningTarget: string[] = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        cacheDump[cacheName] = requests.map((request) => new URL(request.url).pathname);
        if (!cacheName.startsWith("chapterline-shell-")) continue;
        for (const request of requests) {
          const { pathname, search } = new URL(request.url);
          if (pathname.startsWith("/_next/static/") || pathname.startsWith("/icons/")) continue;
          const response = await cache.match(request);
          if (!response) continue;
          const body = await response.clone().text();
          if (body.includes(userId) || (email && body.includes(email))) {
            shellBodiesMentioningTarget.push(pathname + search);
          }
        }
      }

      const localStorageKeys: string[] = [];
      const localStorageMentioningTarget: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key) continue;
        localStorageKeys.push(key);
        const value = localStorage.getItem(key) ?? "";
        if (key.includes(userId) || value.includes(userId)) localStorageMentioningTarget.push(key);
      }

      return {
        databases,
        stores,
        caches: cacheDump,
        shellBodiesMentioningTarget,
        localStorageKeys,
        localStorageMentioningTarget,
        activeUser: localStorage.getItem("chapterline:active-user"),
      };
    },
    [targetUserId, targetEmail ?? ""] as const,
  );
}

/** Every store that still holds a record belonging to, or naming, the account. */
export function residueOf(storage: DeviceStorage): string[] {
  return Object.entries(storage.stores)
    .filter(([, dump]) => dump.ownedByTarget > 0 || dump.mentionsTarget > 0)
    .map(
      ([name, dump]) =>
        `${name}: ${dump.ownedByTarget} owned / ${dump.mentionsTarget} mentioning ` +
        `(keys: ${dump.keys.slice(0, 4).join(", ")}${dump.keys.length > 4 ? ", …" : ""})`,
    );
}

/** Media entries this device holds, which exist nowhere else in the world. */
export function mediaEntries(storage: DeviceStorage): string[] {
  return Object.entries(storage.caches)
    .filter(([name]) => name.startsWith("chapterline-media"))
    .flatMap(([, paths]) => paths);
}

/** Page-cache entries that are not the user-agnostic shell of section 8. */
export function accountBearingPageEntries(storage: DeviceStorage): string[] {
  return Object.entries(storage.caches)
    .filter(([name]) => name.startsWith("chapterline-shell-"))
    .flatMap(([, paths]) => paths)
    .filter(
      (pathname) =>
        pathname !== "/offline" &&
        // The launch shell: the SAME document as /offline, stored under the
        // start_url so the service worker's static route can answer a cold
        // launch without booting the worker. Its BYTES are checked by
        // `shellBodiesMentioningTarget`, which is a stronger claim than this
        // pathname allowlist has ever made about /offline.
        pathname !== "/library" &&
        !pathname.startsWith("/icons/") &&
        !pathname.startsWith("/_next/static/"),
    );
}
