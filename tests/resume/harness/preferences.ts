import { expect, type Page } from "@playwright/test";

import {
  PREFERENCES_DEFAULTS_HEADER,
  PREFERENCES_DEFAULTS_VERSION,
  PREFERENCES_WRITE_ID_HEADER,
} from "../../../src/lib/preferences";

/**
 * The resume oracle covers the optional rewind ladder as well as exact resume,
 * so it opts in explicitly instead of depending on the product default.
 */
export async function enableSmartRewindForOracle(
  page: Page,
  userId: string,
  libraryUrl: string,
): Promise<void> {
  const legacyStatus = await patchSmartRewind(page, false);
  expect(legacyStatus, "the rollout probe's legacy preference write failed").toBe(200);
  await remountPreferences(page, libraryUrl);
  await expectCachedSmartRewind(
    page,
    userId,
    false,
    "an unversioned installed client restored ambiguous smart rewind",
  );

  const status = await patchSmartRewind(page, true);
  expect(status, "the resume oracle could not opt into smart rewind").toBe(200);
  await remountPreferences(page, libraryUrl);
  await expectCachedSmartRewind(
    page,
    userId,
    true,
    "the current client could not opt into smart rewind",
  );
}

async function patchSmartRewind(page: Page, currentVersion: boolean): Promise<number> {
  return page.evaluate(
    async ({ current, defaultsHeader, defaultsVersion, writeIdHeader }) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (current) {
        headers[defaultsHeader] = String(defaultsVersion);
        headers[writeIdHeader] = crypto.randomUUID();
      }
      const response = await fetch(current ? "/api/preferences/v2" : "/api/preferences", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ smartRewind: true }),
      });
      return response.status;
    },
    {
      current: currentVersion,
      defaultsHeader: PREFERENCES_DEFAULTS_HEADER,
      defaultsVersion: PREFERENCES_DEFAULTS_VERSION,
      writeIdHeader: PREFERENCES_WRITE_ID_HEADER,
    },
  );
}

async function remountPreferences(page: Page, libraryUrl: string): Promise<void> {
  await page.goto(libraryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
}

async function expectCachedSmartRewind(
  page: Page,
  userId: string,
  expected: boolean,
  message: string,
): Promise<void> {
  await page
    .waitForFunction(
      ({ expectedValue, id }) => {
        try {
          const cached = JSON.parse(
            localStorage.getItem(`chapterline:preferences:${id}`) || "null",
          ) as { preferences?: { smartRewind?: boolean } } | null;
          return cached?.preferences?.smartRewind === expectedValue;
        } catch {
          return false;
        }
      },
      { expectedValue: expected, id: userId },
      { timeout: 90_000 },
    )
    .catch((error: unknown) => {
      throw new Error(message, { cause: error });
    });
}
