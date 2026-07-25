import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  ACCOUNT_A,
  cutNetwork,
  ensureAccount,
  network,
  openDevice,
  restoreNetwork,
  sessionFor,
  warmUp,
  type Account,
  type Device,
  type StorageState,
} from "./harness/app";
import { seedLibrary, waitForSeededMirror } from "./harness/library-seed";
import { readLibrary } from "./harness/snapshot";

/**
 * The pictures, regenerated rather than remembered.
 *
 * The parity gate already proves online and offline render the same thing, and
 * it proves it structurally, which is stronger than any image comparison. This
 * file exists for the other half of the claim: a person has to be able to LOOK
 * at the offline library and see a real library rather than a spinner, an
 * apology or a skeleton.
 *
 * These are written by the suite so they cannot drift from the code the way a
 * screenshot pasted into a document does. If the offline library ever regresses
 * to an empty box, the image regenerates as an empty box and the assertions
 * below fail in the same run.
 */

const PHONE_VIEWPORT = { width: 393, height: 852 };
const SHOTS = path.join(process.cwd(), "test-results/evidence");

let account: Account;
let state: StorageState;
let device: Device;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  account = await ensureAccount(browser, ACCOUNT_A);
  state = await sessionFor(browser, account);
  device = await openDevice(browser, { storageState: state, deviceId: "evidence-device-00001" });
  await warmUp(device.page);
  await seedLibrary(browser, account, state, device);
  await waitForSeededMirror(device.page, device.origin);
});

test.afterAll(async () => {
  const net = await network();
  net.restore();
  await device?.context.close();
});

test.afterEach(async () => {
  const net = await network();
  if (net.isCut()) await restoreNetwork(device.page);
});

async function launch(url: string, viewport = PHONE_VIEWPORT): Promise<Page> {
  const page = await device.context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
  await page.waitForTimeout(1_200);
  return page;
}

/**
 * A screenshot is only evidence if something checked what is in it. An empty
 * library photographs beautifully and proves the opposite of what it is filed
 * under, so every capture below asserts the marker says `books` and that real
 * cards are on screen before the shutter.
 */
async function capture(page: Page, name: string, label: string): Promise<number> {
  const snapshot = await readLibrary(page);
  expect(
    snapshot.launchReady,
    `${label}: the readiness marker did not name real book cards, so this screenshot would be ` +
      "filed as a working library while showing something else",
  ).toBe("books");
  expect(snapshot.books.length, `${label}: no book cards were on screen`).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  return snapshot.books.length;
}

test("the library looks the same, and real, with the network on and gone", async () => {
  const net = await network();

  const online = await launch(`${device.origin}/library`);
  const onlineCards = await capture(online, "library-online", "online library");
  await online.close();

  await cutNetwork(device.page);
  net.reset();
  const offline = await launch(`${device.origin}/library`);
  const offlineCards = await capture(offline, "library-offline", "offline library");
  await offline.close();

  expect(
    net.hits().map((hit) => `${hit.kind} ${hit.method} ${hit.path}`),
    "the offline capture reached the app server, so it is not a picture of an offline launch",
  ).toStrictEqual([]);
  expect(offlineCards, "the offline library showed a different number of books").toBe(onlineCards);

  console.log(
    `[evidence] ${onlineCards} book cards online and offline · ` +
      `${path.relative(process.cwd(), SHOTS)}/library-online.png, library-offline.png`,
  );
});

test("a book whose audio is not on this device says so, on screen", async () => {
  // Wide, and in list view, deliberately. A grid card carries no play control
  // for anything, so "it does not look playable" is only a claim with content
  // in list view — and the toggle that reaches list view is display:none below
  // 560px. Photographing the phone grid would document the marking while
  // quietly skipping the part about never looking playable.
  const page = await launch(`${device.origin}/library`, { width: 760, height: 900 });
  await page.getByRole("button", { name: "List view" }).click();
  await expect.poll(async () => (await readLibrary(page)).listMode).toBe(true);
  const snapshot = await readLibrary(page);

  const absent = snapshot.books.filter((book) => !book.onDevice);
  const present = snapshot.books.filter((book) => book.onDevice);
  expect(
    absent.length,
    "the seeded library holds no off-device book, so this screenshot would prove nothing",
  ).toBeGreaterThan(0);
  expect(
    present.length,
    "the seeded library holds no on-device book to contrast against",
  ).toBeGreaterThan(0);

  // The honesty rule, in the picture and in the assertion: marked, still fully
  // browsable, and never offering a way to play something that cannot play.
  for (const book of absent) {
    expect(book.offDeviceBadge, `"${book.title}" is not on this device but carries no badge`).toBe(
      true,
    );
    expect(
      book.deviceLine,
      `"${book.title}" says nothing about the audio being elsewhere`,
    ).not.toBe("");
    expect(book.playLink, `"${book.title}" offers a play link for audio this device lacks`).toBe(
      false,
    );
    expect(
      book.playUnavailable,
      `"${book.title}" gives no honest stand-in for the play control`,
    ).toBe(true);
  }

  await page.screenshot({ path: path.join(SHOTS, "not-on-this-device.png"), fullPage: true });
  await page.close();

  console.log(
    `[evidence] ${absent.length} off-device and ${present.length} on-device cards · ` +
      `${path.relative(process.cwd(), SHOTS)}/not-on-this-device.png`,
  );
});
