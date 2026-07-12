import { expect, test } from "@playwright/test";
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
  await expect(page.getByRole("link", { name: "iPhone Downloads Test" })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("link", { name: "iPhone Downloads Test" }).click();
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

  await page.goto("/offline");
  await expect(page.getByRole("button", { name: "Open iPhone Downloads Test" })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
  runtimeErrors.length = 0;
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Open iPhone Downloads Test" }).click();
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
});
