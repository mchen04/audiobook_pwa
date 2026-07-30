import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  attachDriver,
  closeSql,
  commit,
  createCollection,
  DATABASE_HOST,
  drainOutbox,
  evictMirror,
  goOffline,
  goOnline,
  openDevice,
  outbox,
  pull,
  replay,
  resetAccount,
  sharedSession,
  waitForServiceWorker,
  type Account,
  type StorageState,
} from "./harness/app";
import type { FuzzOp } from "./harness/driver-entry";
import { compare, LibraryModel, summarize, type Intent } from "./harness/model";
import { Random } from "./harness/random";
import { positiveInt, resolveSyncSeeds } from "./harness/seeds";
import { readBookIds, readDeviceState, readServerState, readTagIds } from "./harness/state";

/**
 * The outbox fuzz.
 *
 * One question, asked many times with different randomness: after an arbitrary
 * interleaving of library mutations, offline/online transitions and reloads,
 * did the user lose a write?
 *
 * The answer is decided by `harness/model.ts` — an expectation computed from
 * the operations the test issued, compared against Postgres over SQL and
 * against the mirror after a completed pull. It is never decided by asking the
 * app what it thinks it did.
 *
 * Every mutation is issued through the production API in
 * `src/lib/offline/outbox.ts`. Nothing here writes an outbox row, a coalesce
 * key or a replay request by hand — a verifier that did would be grading its
 * own copy of the engine rather than the shipping one.
 */

// ------------------------------------------------------------------ settings
const OPS_PER_SEED = positiveInt(process.env.HARK_SYNC_OPS, 26, "HARK_SYNC_OPS");

const TAG_VOCABULARY = ["fiction", "history", "reread", "commute", "long"] as const;
const COLLECTION_NAMES = ["Winter", "Queue"] as const;
const DURATION_MS = 600_000;

/**
 * An explicit, loudly announced narrowing for bisecting a red run. It is NOT a
 * way to make the suite green: the default run generates every kind, and a run
 * that used this is banner-printed in its own output so a passing result can
 * never be mistaken for a clean one.
 */
const OMITTED_KINDS = new Set(
  (process.env.HARK_SYNC_OMIT_KINDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const SEEDS = resolveSyncSeeds();
if (SEEDS.length === 0) throw new Error("The sync fuzz verifier resolved zero seeds");

test.beforeAll(() => {
  console.log(
    `[sync-fuzz] database host: ${DATABASE_HOST} · seeds: ${SEEDS.join(", ")} · ` +
      `${OPS_PER_SEED} operations per seed`,
  );
  console.log(
    "[sync-fuzz] reproduce one seed with: HARK_SYNC_SEED=<seed> pnpm test:sync · " +
      "HARK_SYNC_SEEDS=<n> sets the seed count · HARK_SYNC_OPS=<n> the operations per seed · " +
      "HARK_SYNC_SEED_BASE=random explores new ground",
  );
  if (OMITTED_KINDS.size) {
    console.log(
      "=".repeat(100) +
        `\n[sync-fuzz] WARNING — HARK_SYNC_OMIT_KINDS=${[...OMITTED_KINDS].join(",")} is set. ` +
        "These mutation kinds were NOT generated, so a green result from this run says nothing " +
        "about them. A clean run is one with this variable unset.\n" +
        "=".repeat(100),
    );
  }
});

test.afterAll(async () => {
  await closeSql();
});

// ------------------------------------------------------------------ payloads
function importPayload(fingerprint: string, title: string, author: string) {
  return {
    // The device names the book, exactly as `local-import.ts` does: the id has
    // to exist before the audio can be written under it, so a registration
    // without one is not the shape the product ever sends.
    bookId: crypto.randomUUID(),
    fileName: encodeURIComponent(`${fingerprint.slice(0, 12)}.mp3`),
    byteSize: 4_194_304,
    durationMs: DURATION_MS,
    fingerprint,
    fingerprintKind: "sha256-v1",
    title,
    author,
    narrator: null,
    chapterDiagnostic: null,
    chapters: chapterList(),
  };
}

function chapterList() {
  return [
    { position: 0, title: "Opening", startMs: 0, endMs: 200_000 },
    { position: 1, title: "Middle", startMs: 200_000, endMs: 400_000 },
    { position: 2, title: "Close", startMs: 400_000, endMs: DURATION_MS },
  ];
}

/** Deterministic, unique per seed and index, and a valid sha256-shaped id. */
function fingerprintFor(seed: number, index: number): string {
  return `${seed.toString(16)}${index.toString(16).padStart(4, "0")}`.padStart(64, "f").slice(-64);
}

// ------------------------------------------------------------------ the run
type SeedWorld = {
  page: Page;
  context: BrowserContext;
  account: Account;
  deviceId: string;
  model: LibraryModel;
  random: Random;
  /** Book ids the SERVER assigned, read back over SQL — never from the mirror. */
  bookIds: Map<string, string>;
  tagIds: Map<string, string>;
  collectionIds: Map<string, string>;
  online: boolean;
  imported: number;
  reloads: number;
  offlineSpells: number;
  /** The largest queue that was carried across a reload, for the shape report. */
  queuedAcrossReload: number;
};

// One sign-in for the whole file; every seed then runs on a BRAND NEW device
// (empty IndexedDB, empty Cache Storage) that adopts the session.
let session: { account: Account; storageState: StorageState } | null = null;

for (const seed of SEEDS) {
  test(`seed ${seed}: no library mutation is lost across offline, online and reload`, async ({
    browser,
  }) => {
    session ??= await sharedSession(browser);
    const { account, storageState } = session;
    // Every seed starts from an empty library on the server as well as on the
    // device, so "the server holds a book the user never imported" stays a real
    // failure rather than leftovers from the previous seed.
    await resetAccount(account.userId);

    const deviceId = `fuzz-device-${seed}`.padEnd(20, "0");
    const { context, page } = await openDevice(browser, deviceId, storageState);
    await page.goto(`${APP_ORIGIN}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 60_000 });
    await attachDriver(page, account, deviceId);
    await waitForServiceWorker(page);
    await attachDriver(page, account, deviceId);

    const world: SeedWorld = {
      page,
      context,
      account,
      deviceId,
      model: new LibraryModel(),
      random: new Random(seed),
      bookIds: new Map(),
      tagIds: new Map(),
      collectionIds: new Map(),
      online: true,
      imported: 0,
      reloads: 0,
      offlineSpells: 0,
      queuedAcrossReload: 0,
    };

    try {
      await bootstrap(world, seed);
      for (let index = 0; index < OPS_PER_SEED; index += 1) {
        await maybeDisturb(world, index);
        await step(world, seed, index);
      }
      await settle(world);
      await assertNoLostWrites(world, seed);
    } finally {
      await context.close();
    }
  });
}

/**
 * One anchor book, the tag vocabulary and the collections.
 *
 * The anchor exists because a tag id is only mintable by attaching the name to
 * some book (`PATCH /api/books/:id` with `tags`), and `deleteUnusedTags` GCs any
 * tag no book references. The anchor holds every vocabulary tag for the whole
 * seed and is never a target of a generated operation, which keeps the tag ids
 * stable while the fuzz adds and removes edges on the other books.
 */
async function bootstrap(world: SeedWorld, seed: number): Promise<void> {
  const fingerprint = fingerprintFor(seed, 9999);
  await commit(world.page, {
    kind: "import",
    fingerprint,
    payload: importPayload(fingerprint, "Anchor", "Anchor Author"),
  });
  await drainOutbox(world.page);
  world.bookIds = await readBookIds(world.account.userId);
  const anchorId = world.bookIds.get(fingerprint);
  expect(anchorId, "the anchor import did not reach the server").toBeTruthy();

  await commit(world.page, {
    kind: "rename",
    bookId: anchorId!,
    fields: { tags: [...TAG_VOCABULARY] },
  });
  await drainOutbox(world.page);
  world.tagIds = await readTagIds(world.account.userId);
  expect(
    [...world.tagIds.keys()].sort(),
    "the tag vocabulary was not created, so no tag-edge operation below would address a real tag",
  ).toStrictEqual([...TAG_VOCABULARY].sort());

  for (const name of COLLECTION_NAMES) {
    world.collectionIds.set(name, await createCollection(world.page, name));
    world.model.declareCollection(name);
  }
  expect(await pull(world.page)).toBe("applied");

  // The anchor is part of the account, so the oracle has to know about it.
  world.model.apply(
    { at: -1, kind: "import", fingerprint },
    {
      title: "Anchor",
      author: "Anchor Author",
      durationMs: DURATION_MS,
      chapters: chapterList(),
      archived: false,
      deleted: false,
      tags: new Set(TAG_VOCABULARY),
      collections: new Set(),
      progress: null,
      history: [],
    },
  );
}

/** Random offline/online transitions, reloads and spontaneous replays. */
async function maybeDisturb(world: SeedWorld, index: number): Promise<void> {
  const roll = world.random.next();
  if (roll < 0.18) {
    if (world.online) {
      await goOffline(world.context, world.page);
      world.online = false;
      world.offlineSpells += 1;
    } else {
      // Reconnect: the `online` event is what the app listens for, and the
      // drain that follows makes the moment the queue empties deterministic
      // without changing who delivers it.
      await goOnline(world.context, world.page);
      world.online = true;
      await resync(world);
    }
    return;
  }
  if (roll < 0.24) {
    // A forced relaunch, deliberately taken while the queue is still full: the
    // outbox is IndexedDB, so every intent queued during the offline spell has
    // to survive the reload, and the delivery is left to the app's OWN launch
    // path (`use-progress-persistence` replays on mount, `use-library-books`
    // pulls after paint) rather than to a driver call.
    if (!world.online) {
      await world.context.setOffline(false);
      world.online = true;
    }
    const queuedBefore = (await outbox(world.page)).length;
    await world.page.reload({ waitUntil: "domcontentloaded" });
    await world.page.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 60_000,
    });
    await attachDriver(world.page, world.account, world.deviceId);
    world.reloads += 1;
    world.queuedAcrossReload = Math.max(world.queuedAcrossReload, queuedBefore);
    void index;
    await resync(world);
    return;
  }
  if (roll < 0.4 && world.online) {
    await replay(world.page);
    await refreshServerIds(world);
  }
}

/**
 * Back in step with the server: the queue delivered, and the MIRROR caught up.
 *
 * The pull is not an extra thing the harness does to the device — it is what
 * the device does to itself, at both of the moments this is called from:
 *
 *  - on reconnect, because `use-library-books` pulls on the `online` event
 *    (design contract section 6; the listener is in that file);
 *  - after an import lands, because `library-client.tsx` awaits `reload()` when
 *    `importLocalMp3` returns, and `reload` is "after an import: pull it back
 *    down, then re-read".
 *
 * Awaiting it here only makes the moment deterministic, exactly as the drain
 * makes the moment the queue empties deterministic.
 *
 * It is load-bearing, and not only for realism. The app resolves a deleted
 * book's file identity from the mirror, so a device that had never pulled would
 * be asked to delete a book it knows nothing about — a state no UI can reach,
 * since a user can only delete a row they can see, and every row they can see
 * came from the mirror or from a download record. A generated op must not be
 * able to reach a state the product cannot.
 *
 * This changes no random draw, so the sequence of generated operations for a
 * given seed is byte for byte what it was.
 */
async function resync(world: SeedWorld): Promise<void> {
  await drainOutbox(world.page);
  expect(await pull(world.page), "the reconnect pull did not complete").toBe("applied");
  await refreshServerIds(world);
}

async function refreshServerIds(world: SeedWorld): Promise<void> {
  world.bookIds = await readBookIds(world.account.userId);
}

/** Books the user can still act on: live, not the anchor, and named by the server. */
function eligible(world: SeedWorld): string[] {
  return world.model
    .live()
    .filter((book) => book.title !== "Anchor")
    .map((book) => book.fingerprint)
    .filter((fingerprint) => world.bookIds.has(fingerprint))
    .sort();
}

/**
 * One generated user action.
 *
 * The op is chosen from the seeded PRNG and then bound to a target that exists;
 * when nothing is eligible the step falls back to an import, so a seed always
 * makes forward progress rather than silently doing nothing.
 */
async function step(world: SeedWorld, seed: number, index: number): Promise<void> {
  let candidates = eligible(world);
  // A book only becomes addressable once the server has named it, so a seed
  // that never lets its imports land would degenerate into an import-only run
  // and pass while testing nothing. When the pool is thin and the network is
  // up, the queue is flushed so the other nine operation kinds have targets.
  if (candidates.length < 3 && world.online) {
    await resync(world);
    candidates = eligible(world);
  }

  const kind = pickKind(world.random, candidates.length > 0);
  if (kind === "import" || !candidates.length) return doImport(world, seed, index);

  const fingerprint = world.random.pick(candidates);
  const bookId = world.bookIds.get(fingerprint)!;
  switch (kind) {
    case "rename": {
      const title = `Retitled ${seed}-${index}`;
      const author = `Author ${seed}-${index}`;
      await run(
        world,
        { at: index, kind: "rename", fingerprint, title, author },
        {
          kind: "rename",
          bookId,
          fields: { title, author },
        },
      );
      return;
    }
    case "tag-add": {
      const tag = world.random.pick(TAG_VOCABULARY);
      await run(
        world,
        { at: index, kind: "tag-add", fingerprint, tag },
        {
          kind: "tag",
          bookId,
          tagId: world.tagIds.get(tag)!,
          include: true,
        },
      );
      return;
    }
    case "tag-remove": {
      const tag = world.random.pick(TAG_VOCABULARY);
      await run(
        world,
        { at: index, kind: "tag-remove", fingerprint, tag },
        {
          kind: "tag",
          bookId,
          tagId: world.tagIds.get(tag)!,
          include: false,
        },
      );
      return;
    }
    case "collection-add": {
      const collection = world.random.pick(COLLECTION_NAMES);
      await run(
        world,
        { at: index, kind: "collection-add", fingerprint, collection },
        {
          kind: "collection",
          collectionId: world.collectionIds.get(collection)!,
          bookId,
          include: true,
        },
      );
      return;
    }
    case "collection-remove": {
      const collection = world.random.pick(COLLECTION_NAMES);
      await run(
        world,
        { at: index, kind: "collection-remove", fingerprint, collection },
        {
          kind: "collection",
          collectionId: world.collectionIds.get(collection)!,
          bookId,
          include: false,
        },
      );
      return;
    }
    case "archive": {
      const archived = world.random.chance(0.5);
      await run(
        world,
        { at: index, kind: "archive", fingerprint, archived },
        {
          kind: "archive",
          bookId,
          archived,
        },
      );
      return;
    }
    case "progress": {
      const positionMs = world.random.int(DURATION_MS - 1_000);
      const completed = world.random.chance(0.2);
      await run(
        world,
        { at: index, kind: "progress", fingerprint, positionMs, completed },
        {
          kind: "progress",
          bookId,
          positionMs,
          playbackRate: 1,
          completed,
          eventOccurredAt: new Date().toISOString(),
        },
      );
      return;
    }
    case "history": {
      const result = await commit(world.page, {
        kind: "history",
        bookId,
        event: {
          action: "seek",
          positionMs: world.random.int(DURATION_MS - 1_000),
          previousPositionMs: 0,
          playbackRate: 1,
          description: `fuzz ${seed}-${index}`,
          occurredAt: new Date().toISOString(),
        },
      });
      world.model.apply({ at: index, kind: "history", fingerprint, mutationId: result.mutationId });
      return;
    }
    case "delete": {
      await run(world, { at: index, kind: "delete", fingerprint }, { kind: "delete", bookId });
      world.bookIds.delete(fingerprint);
      return;
    }
  }
}

/**
 * An import, and one in five of them is the SAME FILE AGAIN.
 *
 * A fingerprint the library already holds is not an edge case: it is what the
 * recovery in design contract section 10 looks like from the route's side, and
 * it is the only way a registration ever meets `media_assets`' uniqueness on
 * (owner, kind, fingerprint). The duplicate must merge onto the book that
 * already owns those bytes — the model folds it that way, and the duplicate
 * check in `compare` is what notices a second book appearing instead.
 *
 * A fuzz that minted a fresh fingerprint every time, as this one did, could
 * never generate the case at all.
 */
const DUPLICATE_IMPORT_CHANCE = 0.2;

async function doImport(world: SeedWorld, seed: number, index: number): Promise<void> {
  const known = world.model.liveFingerprints();
  const reimport = known.length > 0 && world.random.chance(DUPLICATE_IMPORT_CHANCE);
  const fingerprint = reimport ? world.random.pick(known) : fingerprintFor(seed, world.imported);
  if (!reimport) world.imported += 1;
  const title = `Imported ${seed}-${index}`;
  const author = `Importer ${seed}`;
  await commit(world.page, {
    kind: "import",
    fingerprint,
    payload: importPayload(fingerprint, title, author),
  });
  world.model.apply(
    { at: index, kind: "import", fingerprint },
    {
      title,
      author,
      durationMs: DURATION_MS,
      chapters: chapterList(),
      archived: false,
      deleted: false,
      tags: new Set(),
      collections: new Set(),
      progress: null,
      history: [],
    },
  );
}

async function run(world: SeedWorld, intent: Intent, op: FuzzOp): Promise<void> {
  await commit(world.page, op);
  world.model.apply(intent);
}

type Weighted = { kind: Exclude<Intent["kind"], never>; weight: number };

const WEIGHTS: Weighted[] = [
  { kind: "import", weight: 2 },
  { kind: "rename", weight: 3 },
  { kind: "tag-add", weight: 3 },
  { kind: "tag-remove", weight: 2 },
  { kind: "collection-add", weight: 3 },
  { kind: "collection-remove", weight: 2 },
  { kind: "archive", weight: 2 },
  { kind: "progress", weight: 4 },
  { kind: "history", weight: 2 },
  { kind: "delete", weight: 1 },
];

function pickKind(random: Random, hasTargets: boolean): Intent["kind"] {
  const pool = WEIGHTS.filter(
    (entry) =>
      !OMITTED_KINDS.has(entry.kind) &&
      !OMITTED_KINDS.has(entry.kind.split("-")[0] as string) &&
      (hasTargets || entry.kind === "import"),
  );
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random.next() * total;
  for (const entry of pool) {
    roll -= entry.weight;
    if (roll <= 0) return entry.kind;
  }
  return "import";
}

/** Back online, queue drained, one full pull applied. */
async function settle(world: SeedWorld): Promise<void> {
  if (!world.online) {
    await goOnline(world.context, world.page);
    world.online = true;
  }
  await drainOutbox(world.page);
  expect(await pull(world.page), "the final pull did not complete").toBe("applied");
}

/** Kinds this run is supposed to exercise, after any explicit omission. */
const EXPECTED_KINDS = WEIGHTS.map((entry) => entry.kind).filter(
  (kind) => !OMITTED_KINDS.has(kind) && !OMITTED_KINDS.has(kind.split("-")[0] as string),
);

/** Every intent kind executed in THIS worker, for the tally at the end. */
const kindsSeen = new Map<string, number>();

test.afterAll(() => {
  if (!kindsSeen.size) return;
  console.log(
    "[sync-fuzz] operation mix in this worker: " +
      [...kindsSeen.entries()]
        .sort()
        .map(([kind, total]) => `${kind}×${total}`)
        .join(" "),
  );
});

/**
 * Proves the generator can reach every kind, without needing a browser or a
 * complete worker.
 *
 * The per-seed check below refuses a seed that exercised fewer than five kinds,
 * but a kind that could NEVER be produced — dropped from the weight table,
 * shadowed by a filter, unreachable because `pickKind` falls through — would
 * slip past it silently and leave a whole mutation path untested while the
 * suite reported green. Playwright starts a fresh worker after every failing
 * test, so an aggregate counted across the run cannot be trusted to see them
 * all; this is deterministic and worker-independent instead.
 */
test("the operation generator can produce every mutation kind", () => {
  const produced = new Set<string>();
  const random = new Random(0xf022);
  for (let draw = 0; draw < 20_000; draw += 1) produced.add(pickKind(random, true));
  expect(
    EXPECTED_KINDS.filter((kind) => !produced.has(kind)),
    "these mutation kinds can never be generated, so no seed can possibly exercise them",
  ).toStrictEqual([]);
  expect(
    [...produced].filter((kind) => !EXPECTED_KINDS.includes(kind as never)),
    "the generator produces a kind the coverage bar does not know about",
  ).toStrictEqual([]);
});

async function assertNoLostWrites(world: SeedWorld, seed: number): Promise<void> {
  const server = await readServerState(world.account.userId);

  // Two device observations, because they can fail differently.
  //
  //  1. The mirror as the seed left it: optimistic projections plus whatever
  //     the incremental pulls delivered. This is what the user is looking at.
  //  2. The mirror rebuilt from scratch. Wiping it and pulling again removes
  //     every optimistic patch, so what remains came only from Postgres. A
  //     change that was applied locally but never made it into another
  //     device's cursor window is invisible in (1) and obvious here — that is
  //     precisely what a missing parent `updatedAt` bump looks like.
  const live = await readDeviceState(world.page);
  await evictMirror(world.page);
  expect(await pull(world.page), "the rebuild pull did not complete").toBe("applied");
  const rebuilt = await readDeviceState(world.page);

  const problems = [
    ...compare(world.model, server, live),
    ...compare(world.model, server, rebuilt).filter((problem) => problem.where === "device"),
  ];

  const perKind = new Map<string, number>();
  for (const intent of world.model.intents) {
    perKind.set(intent.kind, (perKind.get(intent.kind) || 0) + 1);
    kindsSeen.set(intent.kind, (kindsSeen.get(intent.kind) || 0) + 1);
  }

  const shape =
    `seed ${seed}: ${world.model.intents.length} intents · ${world.model.live().length} live ` +
    `books · ${world.offlineSpells} offline spells · ${world.reloads} reloads · ` +
    `${world.queuedAcrossReload} queued rows carried across a reload`;
  const mix = [...perKind.entries()]
    .sort()
    .map(([kind, total]) => `${kind}×${total}`)
    .join(" ");
  console.log(
    `[sync-fuzz] ${shape}\n            mix: ${mix}` +
      `${problems.length ? `\n            DIVERGENCE: ${summarize(problems)}` : "\n            clean"}`,
  );

  // A seed that exercised nothing would pass trivially, so the shape of the
  // run is asserted before its outcome is trusted.
  expect(world.model.intents.length, `${shape}: no intents were generated`).toBeGreaterThan(5);
  expect(
    world.model.live().length,
    `${shape}: the seed ended with no live books, so nothing was checked`,
  ).toBeGreaterThan(1);
  expect(
    world.offlineSpells + world.reloads,
    `${shape}: neither an offline spell nor a reload happened, so this seed never tested ` +
      "durability at all",
  ).toBeGreaterThan(0);
  expect(
    perKind.size,
    `${shape}: only ${[...perKind.keys()].sort().join(", ")} were generated. A seed that ` +
      "exercised one or two kinds proves almost nothing about the others.",
  ).toBeGreaterThanOrEqual(5);

  expect(
    await outbox(world.page),
    `${shape}: the outbox still holds rows after draining with the network up`,
  ).toStrictEqual([]);

  expect(
    problems.map((problem) => `${problem.where}: ${problem.intent} — ${problem.detail}`),
    `${shape}\nZERO LOST WRITES violated. Reproduce with: HARK_SYNC_SEED=${seed} pnpm test:sync`,
  ).toStrictEqual([]);
}
