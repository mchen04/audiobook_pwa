import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const fixture = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
const multiChunkFixture = Buffer.concat([
  readFileSync(fixture),
  // ID3/MPEG decoders ignore trailing padding. Crossing the 4 MiB boundary
  // makes this flow exercise the same multi-entry storage path as an audiobook
  // without checking a large binary fixture into the repository.
  Buffer.alloc(4 * 1024 * 1024),
]);

/** The card's own title link; the continue card names the same book. */
function bookLink(page: Page) {
  return page.getByRole("link", { name: "iPhone Downloads Test", exact: true });
}

test("imports from iPhone Downloads, plays, seeks, relaunches, and works offline", async ({
  context,
  page,
}) => {
  const runtimeErrors: string[] = [];
  const offlineMediaResponses: Array<{ status: number; range: string | null }> = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.startsWith("/offline-media/")) return;
    offlineMediaResponses.push({
      status: response.status(),
      range: response.headers()["content-range"] || null,
    });
  });

  // iOS exposes this flag only when Safari launches the site from its Home
  // Screen icon. WebKit still supplies the actual iPhone engine and user agent.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  });

  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.goto("/register");
  await expect.poll(() => page.evaluate(() => navigator.userAgent)).toContain("iPhone");
  await expect
    .poll(() => page.evaluate(() => (navigator as Navigator & { standalone?: boolean }).standalone))
    .toBe(true);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await page.getByLabel("Name").fill("iPhone PWA Test");
  await page.getByLabel("Email").fill(`iphone-pwa-${unique}@example.test`);
  await page.getByLabel(/Password/).fill("Chapterline-iPhone-Test-2026!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/library/);

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose MP3" }).click();
  await (
    await chooser
  ).setFiles({
    name: path.basename(fixture),
    mimeType: "audio/mpeg",
    buffer: multiChunkFixture,
  });
  await expect(bookLink(page)).toBeVisible({
    timeout: 30_000,
  });

  await bookLink(page).click();
  await expect(page.getByRole("heading", { name: "iPhone Downloads Test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect
    .poll(() => page.getByRole("slider", { name: "Audiobook position" }).inputValue())
    .not.toBe("0");

  await page.getByRole("slider", { name: "Audiobook position" }).fill("4000");
  await expect(page.getByRole("slider", { name: "Audiobook position" })).toHaveValue("4000");

  await page.reload();
  await expect(page.getByRole("heading", { name: "iPhone Downloads Test" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.ready.then(() => true)))
    .toBe(true);

  // There is one library. The old Downloads screen is a facet of it now, so
  // `/offline` lands in that library instead of in a second design.
  await page.goto("/offline");
  await expect(page).toHaveURL(/\/library/);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search your library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "On this device" })).toBeVisible();
  await expect(bookLink(page)).toBeVisible();
  // The continue card is computed from this device's own progress, not fetched.
  await expect(
    page.getByRole("link", { name: "Continue listening iPhone Downloads Test" }),
  ).toBeVisible();

  // Everything the Downloads screen could show, shown on the card: that the
  // book is on this device, what it costs there, and how to remove it.
  const card = page.locator(".book-item", { hasText: "iPhone Downloads Test" });
  await expect(card.getByText(/On this device · [\d.]+ (KB|MB|GB)/)).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Remove download of iPhone Downloads Test" }),
  ).toBeVisible();

  // The header's Downloads control opens the merged library with its facet
  // already on, rather than a screen of its own.
  const downloads = page.locator('header a[href="/library?device=1"]');
  await expect(downloads).toHaveAccessibleName("Downloads");
  await downloads.click();
  await expect(page).toHaveURL(/\/library\?device=1/);
  await expect(page.getByRole("button", { name: "On this device" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(bookLink(page)).toBeVisible();

  // The facet filters the one library; it does not navigate to another screen.
  await page.getByRole("button", { name: "On this device" }).click();
  await expect(page.getByRole("button", { name: "On this device" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(bookLink(page)).toBeVisible();

  await page.getByRole("searchbox", { name: "Search your library" }).fill("no such book");
  await expect(page.getByRole("heading", { name: "No matching books" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search your library" }).fill("");
  await expect(bookLink(page)).toBeVisible();

  expect(runtimeErrors).toEqual([]);
  runtimeErrors.length = 0;

  // With the network genuinely gone the same library keeps working — search
  // included — and the audio saved on this device still plays.
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await page.getByRole("searchbox", { name: "Search your library" }).fill("iPhone");
  await expect(bookLink(page)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search your library" }).fill("");

  await bookLink(page).click();
  await expect(page.getByRole("heading", { name: "iPhone Downloads Test" })).toBeVisible();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect
    .poll(() => offlineMediaResponses.some((response) => response.status === 206))
    .toBe(true);
  expect(
    offlineMediaResponses.some(
      (response) => response.status === 206 && response.range?.startsWith("bytes "),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Pause" }).click();

  // Removing a download removes the audio this device holds and nothing else:
  // the book stays in the library with its metadata, and says plainly that it
  // is no longer playable here.
  await context.unroute("**/*");
  await page.goto("/library");
  await expect(bookLink(page)).toBeVisible();
  await page
    .locator(".book-item", { hasText: "iPhone Downloads Test" })
    .getByRole("button", { name: "Remove download of iPhone Downloads Test" })
    .click();

  const removed = page.locator(".book-item", { hasText: "iPhone Downloads Test" });
  await expect(removed.getByText(/Not on this device/)).toBeVisible();
  await expect(removed.getByRole("button", { name: /Remove download/ })).toHaveCount(0);
  await expect(bookLink(page)).toBeVisible();

  await page.getByRole("button", { name: "On this device" }).click();
  await expect(page.getByRole("heading", { name: "Nothing downloaded yet" })).toBeVisible();
});
