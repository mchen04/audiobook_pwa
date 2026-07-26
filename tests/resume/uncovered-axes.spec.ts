import { expect, test } from "@playwright/test";

import {
  AHEAD_BAR_MS,
  CALLBACK_BAR_MS,
  HARD_KILL_BAR_MS,
  closeResumeFixture,
  measure,
  measureCompletionAcrossBooks,
  measureStaleAheadReplay,
  measureTwoDeviceResume,
  recordRow,
  resumeFixture,
  type Row,
  type ScenarioSpec,
} from "./harness/resume-oracle";

/**
 * The four axes `position-drift.spec.ts` is structurally unable to see.
 *
 * That matrix measures ONE book, on ONE device, with the app's lifecycle
 * handlers intact, and grades the position the PLAYER comes back at. Four real
 * failures live outside that shape, and each one was found by something other
 * than this suite:
 *
 *   S1  The server left holding a position the user rewound away from. The
 *       player is protected by its own local record, so a client-only oracle
 *       reports a clean pass while Postgres — the only witness a second device
 *       or a fresh install has — serves twelve seconds of skipped content.
 *   B1/B2
 *       What the 200 ms cadence preserves ON ITS OWN, with every lifecycle
 *       handler deleted. T1 cannot be covered here (see `assertHiddenIsReal`),
 *       and stays an engine GAP; this bounds the damage of the case T1 is
 *       worried about instead of leaving its size unknown.
 *   X2  One device republishing over another device's newer position. A
 *       single-device oracle has no other device.
 *   F2  Opening the next book un-finishing the previous one. A single-book
 *       oracle has no next book.
 *
 * Ordering is deliberate. B1/B2 run first, while the fixture books still have
 * their full length available; the rows after them reset the book they use, on
 * every witness, because they need a known amount of headroom.
 */

/**
 * One book per scenario, and F2 needs two.
 *
 * These rows used to share three books, which is how one row losing a book's
 * download record took it away from every later row that used it — see the
 * matching note in `position-drift.spec.ts`. The books are ~98 KB against a
 * measured 1 GB Cache Storage quota, so there is no reason to share them.
 */
const BOOK_COUNT = 6;

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await resumeFixture(BOOK_COUNT);
});

test.afterAll(async () => {
  await closeResumeFixture();
});

// ---------------------------------------------------------------------------
// B1 / B2 — the cadence with no lifecycle callback at all
// ---------------------------------------------------------------------------

/**
 * T1's residual, converted from unprovable into BOUNDED BY COMPOSITION.
 *
 * T1 asks whether the app survives a real iOS backgrounding. This instrument
 * cannot make WebKit report a page hidden for real — there is no
 * `Page.setActivityState` anywhere in `playwright-core`, and a second page plus
 * `bringToFront()` leaves the measured page at `"visible"` and fires no
 * `visibilitychange` at all — so T1 stays a GAP, is graded green nowhere, and
 * `assertHiddenIsReal` keeps saying so. These rows do not cover it. What they do
 * is make the size of what is uncovered a measured quantity instead of an
 * unknown, and the argument is worth stating exactly, because "unknown"
 * understates it and "covered" would be a lie.
 *
 * TWO INDEPENDENT MECHANISMS STAND BETWEEN A BACKGROUNDED LISTENER AND A LOST
 * POSITION: the synchronous flush on the lifecycle edge, and a 200 ms
 * `setInterval` that samples the element directly
 * (`use-progress-persistence.ts`). Each has been measured working ALONE.
 *
 *   (a) THE FLUSH, GIVEN THE STATE. The harness overrides
 *       `document.visibilityState` before dispatching, so the app's handler
 *       reads `"hidden"` — the row carries `visibilityAtCallback` as an
 *       observation rather than an assumption, and the app gates its flush on
 *       exactly that value. MEASURED, WebKit, build A7stcwm1IFdVIdgFWr4h9: T1
 *       online drift 39 ms / shelf 39 ms, T1 offline 26 ms / 26 ms.
 *
 *   (b) THE CADENCE, WITH THE FLUSH DELETED. B1/B2 remove every lifecycle
 *       registration the app makes before it can make it, prove the poison bit
 *       (`lifecycleBlocked`), and prove the platform still delivered the
 *       callback (`lifecycle`), so "the app could not use it" is distinguishable
 *       from "it never happened". MEASURED, same build: B1 152 ms, B2 69 ms
 *       against the 600 ms bar below. That bar is proven able to fail — at the
 *       old 5 s cadence the same rows measured 4708 ms and 2867 ms.
 *
 * WHAT THE UNION ESTABLISHES. The two legs do not depend on each other, so a
 * real backgrounding loses the user's place only if BOTH fail at once: the
 * platform never delivers a usable `visibilitychange` AND the timer stops before
 * its next tick. Either one surviving is enough, and each was measured surviving
 * with the other removed. The cost of a SINGLE failure is bounded and known: one
 * cadence interval with no callback, the flush's own latency with one.
 *
 * WHAT IT DOES NOT ESTABLISH, and must never be read as:
 *
 *   1. That iOS delivers the input (a) was handed. The state was SYNTHESISED.
 *      (a) says the handler is correct when given a hidden `visibilitychange`;
 *      it says nothing about whether the platform gives it one. If real iOS
 *      fires the event with the state still `"visible"`, or does not fire it
 *      before freezing, leg (a) contributes nothing and only (b) is left.
 *   2. That the timer keeps running once iOS has frozen the page. B1/B2 bound
 *      "no callback". They do not bound "no callback AND no timer".
 *   3. The joint failure, which is the actual residual — and it is not bounded
 *      by one interval. A backgrounded audiobook keeps PLAYING while a frozen
 *      page writes nothing, so the loss there is the length of the background
 *      listening, not the cadence. T3 does not cover it: T3's page was
 *      foregrounded and ticking right up to the SIGKILL, so its timer had never
 *      stopped.
 *
 * So: the real-world risk is bounded by composition, the single cell is not
 * proven, and covering it needs an engine that can genuinely report a hidden
 * page, or real hardware.
 *
 * THE BAR. These rows get the no-callback bar's CASE but a stricter number:
 * 600 ms, three times the cadence, instead of the 1000 ms `HARD_KILL_BAR_MS`
 * the repo gives a SIGKILL. The cadence's own worst case is one interval, so
 * anything near 1000 ms would mean the cadence is not doing the job this row
 * exists to test.
 */
const CADENCE_ONLY_BAR_MS = 600;

const BACKSTOP: ScenarioSpec[] = [
  {
    scenario: "B1 pagehide, every lifecycle handler dead",
    bookIndex: 0,
    termination: "pagehide",
    network: "online",
    killLifecycleHandlers: true,
    resetBookFirst: true,
  },
  {
    scenario: "B2 hidden, every lifecycle handler dead",
    bookIndex: 1,
    termination: "hidden",
    network: "online",
    killLifecycleHandlers: true,
    resetBookFirst: true,
  },
];

function assertMeasured(row: Row): void {
  expect(row.ticks, `${row.scenario}: no timeupdate ticks — nothing was measured`).toBeGreaterThan(
    2,
  );
  expect(
    row.playedMs,
    `${row.scenario}: the position advanced by ${row.playedMs}ms, which is not a listening ` +
      "session. A zero-drift row from a player that never played is not a pass.",
  ).toBeGreaterThan(4_000);
  expect(
    row.truePositionMs,
    `${row.scenario}: the true position at termination was not a real position`,
  ).toBeGreaterThan(4_000);
}

for (const spec of BACKSTOP) {
  test(`${spec.scenario}: the 200ms cadence alone still holds the position`, async () => {
    test.setTimeout(300_000);
    const row = await measure(spec);
    recordRow(row);
    assertMeasured(row);

    // The poison has to have BITTEN. A row where the app registered nothing is
    // a row measuring an ordinary build, and its green would say nothing about
    // the no-callback world.
    expect(
      row.lifecycleBlocked,
      `${row.scenario}: the app made no \`visibilitychange\` registration for this run to take ` +
        "away, so nothing was disabled and this row is measuring the ordinary build",
    ).toContain("visibilitychange");
    expect(
      row.lifecycleBlocked,
      `${row.scenario}: the app made no \`pagehide\` registration for this run to take away, so ` +
        "nothing was disabled and this row is measuring the ordinary build",
    ).toContain("pagehide");

    // And the platform must still have DELIVERED the callback, or "the app
    // could not use it" is indistinguishable from "it never happened". The
    // journal is written by the oracle's own probe, which registers before the
    // block script runs.
    expect(
      row.lifecycle.map((entry) => entry.split("@")[0]),
      `${row.scenario}: the platform delivered no lifecycle callback at all, so this row is a ` +
        "SIGKILL wearing a backgrounding's name rather than a deaf app",
    ).not.toStrictEqual([]);

    // Skipping content is a blocker at any magnitude, handlers or no handlers.
    expect(
      row.aheadMs,
      `${row.scenario}: the app resumed ${row.aheadMs}ms AHEAD of where the user was`,
    ).toBeLessThanOrEqual(AHEAD_BAR_MS);

    expect(
      row.driftMs,
      `${row.scenario}: with every lifecycle handler deleted the app came back ${row.behindMs}ms ` +
        `behind (true ${row.truePositionMs}ms, resumed ${row.resumedPositionMs}ms, ` +
        `${row.ticks} ticks over ${row.playedMs}ms). The 200ms cadence is the ONLY thing ` +
        "protecting a backgrounded listener when iOS does not deliver the callback, so this " +
        `number is the size of T1's residual. Bar ${CADENCE_ONLY_BAR_MS}ms — three cadence ` +
        `intervals, stricter than the ${HARD_KILL_BAR_MS}ms this repo gives a no-callback case.`,
    ).toBeLessThanOrEqual(CADENCE_ONLY_BAR_MS);

    expect(
      row.shelf.sourceMs,
      `${row.scenario}: the shelf had no position for this book at all`,
    ).not.toBeNull();
    expect(
      row.shelfDriftMs,
      `${row.scenario}: with the handlers dead the library card was ${row.shelfDriftMs}ms off ` +
        `the true position (card showed ${row.shelf.percent}%, underlying ` +
        `${row.shelf.sourceMs}ms, true ${row.truePositionMs}ms)`,
    ).toBeLessThanOrEqual(CADENCE_ONLY_BAR_MS);
  });
}

// ---------------------------------------------------------------------------
// S1 — the server left ahead of the user
// ---------------------------------------------------------------------------

/**
 * The trap, and why every guard below is a guard on the INSTRUMENT.
 *
 * The failure needs three things to line up: a heartbeat that journalled a
 * position, a rewind after it, and a process death inside the 800 ms window
 * before the rewind's own server write fires. Miss any one and the row comes
 * back green having tested nothing — the most dangerous outcome this file can
 * produce, because it would retire a real defect on a vacuous pass. So the row
 * carries the queued value read twice (once before the rewind, once after the
 * kill from a document that runs no app code) and the measured skip-to-kill
 * interval, and each is asserted before the product is graded at all.
 */
test("S1: a kill between the rewind and its write must not leave the server ahead", async () => {
  test.setTimeout(600_000);
  const row = await measureStaleAheadReplay({
    scenario: "S1 stale queued position replayed after a hard kill",
    bookIndex: 2,
    playMs: 16_500,
  });
  recordRow(row);

  expect(row.ticks, "S1: nothing played, so nothing was measured").toBeGreaterThan(2);
  expect(
    row.playedMs,
    `S1: the session advanced ${row.playedMs}ms, which is not a listening session`,
  ).toBeGreaterThan(10_000);

  // --------------------------------------------------------- was it armed?
  expect(
    row.skipToKillMs,
    `S1: UNCOVERED. ${row.skipToKillMs}ms elapsed between the rewind and the SIGKILL, which is ` +
      "past the 800ms seek debounce, so the post-rewind server write had time to be journalled. " +
      "It would then coalesce over the stale row and the trap was never set — this row's green " +
      "would mean nothing.",
  ).toBeLessThan(800);
  expect(
    row.queuedAfterKillCount,
    `S1: UNCOVERED. The outbox held ${row.queuedAfterKillCount} progress rows for this book after ` +
      "the kill, not one. With nothing queued there is nothing for replay to deliver stale, and " +
      "the defect cannot be reached.",
  ).toBe(1);
  expect(
    row.armedAheadMs,
    `S1: UNCOVERED. The queued row was ${row.armedAheadMs}ms ahead of the true position ` +
      `(queued ${row.queuedAfterKillMs}ms, true ${row.truePositionMs}ms, skip back ` +
      `${row.skipBackMs}ms). The trap needs a queued position materially ahead of where the user ` +
      "actually is; this one is not, so replaying it could not skip anything.",
  ).toBeGreaterThan(5_000);
  expect(
    row.outboxDrained,
    "S1: the queued row never left the outbox, so the server value below is what the server held " +
      "BEFORE the replay and this row did not measure the replay at all",
  ).toBe(true);

  // ------------------------------------------------------------- the product
  //
  // THE SERVER, not the client. This device is protected by `localWinsOver`
  // reading its own newer record, so the player comes back in the right place
  // and a client-only oracle sees nothing. The user who is hurt is on a second
  // device, a fresh install or cleared storage: for them Postgres is the only
  // witness, and it is what this asserts.
  expect(
    row.serverAheadMs,
    `S1: after the replay the SERVER holds ${row.serverPositionMs}ms for a user who is at ` +
      `${row.truePositionMs}ms — ${row.serverAheadMs}ms of a book they have not heard. The ` +
      `queued row that did it was ${row.queuedAfterKillMs}ms stamped ${row.queuedAfterKillOccurredAt}, ` +
      `while this device's own durable record already said ${row.localAfterKillMs}ms. This ` +
      "device hides the damage (it came back at " +
      `${row.resumedPositionMs}ms off its local record); a second device, a fresh install or ` +
      "cleared storage would resume from the server and skip.",
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);

  expect(
    row.resumedAheadMs,
    `S1: the player itself came back ${row.resumedAheadMs}ms AHEAD of the true position`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);

  expect(
    row.shelf.sourceMs === null ? 0 : Math.round(row.shelf.sourceMs - row.truePositionMs),
    `S1: the library card is ahead of the user (card source ${row.shelf.sourceMs}ms, true ` +
      `${row.truePositionMs}ms)`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
});

// ---------------------------------------------------------------------------
// F2 — finishing a book, then opening the next
// ---------------------------------------------------------------------------

test("F2: opening the next book must not un-finish the one just finished", async () => {
  test.setTimeout(600_000);
  const row = await measureCompletionAcrossBooks({
    scenario: "F2 finish then open next",
    finishedBookIndex: 3,
    nextBookIndex: 4,
  });
  recordRow(row);

  expect(row.ticks, "F2: nothing played, so the book was never listened to").toBeGreaterThan(2);
  /**
   * THE PRECONDITION IS THE USER ACTION, NOT A FLAG THAT SURVIVED.
   *
   * The obvious gate — "the book was marked finished before the next one
   * opened" — is unusable, and measuring it is what showed why. On the build
   * with the defect, `markEnded` and the autoplay `router.push` fire off the
   * same `ended` event, so the un-finishing write lands in the same tick: the
   * pre-fix run recorded `finishedLocalBefore: false`, `finishedMirrorBefore:
   * false`, `finishedServerBefore: false`. There is no instant at which the
   * flag can be caught. A gate on it would report the exact failure this row
   * exists to name as "the precondition was not met" — the failure hiding
   * behind its own detector.
   *
   * So the precondition is what the USER did: the book reached its end
   * (the harness fails hard if it did not), the app navigated itself to the
   * next book, and the document was never replaced on the way. Whether the
   * completion flag was briefly true in between is not a requirement; that it
   * is true AFTERWARDS is, and that is what is graded below. The `...Before`
   * columns stay in the row because WHEN the flag was lost is evidence.
   */
  expect(row.endedObserved, "F2: the book never reached its end").toBe(true);
  expect(
    row.previousBookWasStillActive,
    `F2: UNCOVERED. Leaving the player dropped the finished book from the provider, so opening ` +
      "the next one had no PREVIOUS book to write to and the defect could not fire. The " +
      "navigation must stay client-side for this row to mean anything.",
  ).toBe(true);
  expect(row.nextBookLoaded, "F2: the next book never loaded").toBe(true);

  expect(
    row.finishedServerAfter,
    `F2: "${row.finishedBookTitle}" was finished, and opening "${row.nextBookTitle}" made the ` +
      `server call it unfinished again (server before ${row.finishedServerBefore}, after ` +
      `${row.finishedServerAfter}). The user finished a book and the app took it back.`,
  ).toBe(true);
  expect(
    row.finishedLocalAfter,
    `F2: this device's own durable record for "${row.finishedBookTitle}" says completed=` +
      `${row.finishedLocalAfter} after the next book was opened (it said ` +
      `${row.finishedLocalBefore} before)`,
  ).not.toBe(false);
  expect(
    row.finishedMirrorAfter,
    `F2: the mirror the shelf renders from says completed=${row.finishedMirrorAfter} for ` +
      `"${row.finishedBookTitle}" (it said ${row.finishedMirrorBefore} before), and the card ` +
      `now reads "${row.finishedStatusText}"`,
  ).not.toBe(false);
});

// ---------------------------------------------------------------------------
// X2 — two devices, one account
// ---------------------------------------------------------------------------

/**
 * ONE journey, TWO tests.
 *
 * The two-device run costs a couple of minutes and produces one row, and the
 * row answers two different questions that must not be able to mask each
 * other: whether a stale tab publishes over another device (X2), and whether
 * the tab it was left in ever catches up (X3). Folding them into a single test
 * would let the first failing assertion hide the second — and, as it turns out,
 * they do not have the same answer on this build.
 */
let twoDeviceRow: Awaited<ReturnType<typeof measureTwoDeviceResume>> | null = null;

async function theTwoDeviceRun() {
  if (twoDeviceRow) return twoDeviceRow;
  twoDeviceRow = await measureTwoDeviceResume({
    scenario: "X2 two devices, stale tab foregrounded",
    bookIndex: 5,
    playMsA: 6_000,
    playMsB: 8_000,
  });
  recordRow(twoDeviceRow);
  return twoDeviceRow;
}

test("X2: a stale tab on one device must not republish over another device", async () => {
  test.setTimeout(900_000);
  const row = await theTwoDeviceRun();

  expect(row.ticksA, "X2: device A never played").toBeGreaterThan(2);
  expect(row.ticksB, "X2: device B never played").toBeGreaterThan(2);
  expect(
    row.deviceIdA === row.deviceIdB,
    `X2: both contexts reported device id ${row.deviceIdA}, so these are two tabs and not two ` +
      "devices",
  ).toBe(false);
  expect(
    row.booksForUser,
    "X2: the two devices are not on the same book, so nothing below compares anything",
  ).toBe(1);

  // 1. Did B resume where A left off? This is the plain cross-device resume the
  //    sync suite never asks, because it never mounts a player.
  expect(
    Math.abs(row.deviceBStartedAtMs - row.deviceAListenedToMs),
    `X2: device A stopped at ${row.deviceAListenedToMs}ms (server ${row.serverAfterAMs}ms) and ` +
      `device B's player started at ${row.deviceBStartedAtMs}ms. Picking a book up on a second ` +
      "device must land where the first one left it.",
  ).toBeLessThanOrEqual(1_500);

  // 2. Did A's stale tab, coming back to the foreground, publish over B?
  expect(
    row.clobberedMs,
    `X2: device A's tab was foregrounded holding ${row.deviceAListenedToMs}ms while device B had ` +
      `already listened to ${row.deviceBListenedToMs}ms, and the server then held ` +
      `${row.serverAfterForegroundMs}ms — ${row.clobberedMs}ms of B's listening published away ` +
      `by a tab that received no user input at all (A's handler saw visibilityState ` +
      `"${row.visibilityAtForeground}"). The server had ${row.serverAfterBMs}ms before A came ` +
      "back.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);

  // 3. Neither device may come back ahead of anything the user has heard.
  expect(
    row.deviceAAheadMs,
    `X2: device A came back at ${row.deviceAResumedMs}ms against a furthest-heard of ` +
      `${row.furthestMs}ms`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
  expect(
    row.deviceBAheadMs,
    `X2: device B came back at ${row.deviceBResumedMs}ms against a furthest-heard of ` +
      `${row.furthestMs}ms`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);

  // 4. And B must not be thrown BACKWARDS by A's republish. Smart rewind is
  //    credited here because both devices paused through the UI and a real
  //    absence is a legitimate, bounded walk back; anything past it is not.
  expect(
    row.deviceBLostMs - row.rewindCreditedB,
    `X2: device B listened to ${row.deviceBListenedToMs}ms and came back at ` +
      `${row.deviceBResumedMs}ms — ${row.deviceBLostMs}ms behind, of which only ` +
      `${row.rewindCreditedB}ms is smart rewind. A stale tab on another device took listening ` +
      "away from this one.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);

  // 5. The second edge. `pagehide` is flushed UNCONDITIONALLY by design — the
  //    reasoning being that it is terminal at any visibility — so closing the
  //    stale tab is a second chance to publish its old position. The visible
  //    edge is guarded; this asks whether the terminal one needs to be too.
  expect(
    row.clobberedByPagehideMs,
    `X2: navigating device A's stale tab away (which delivers \`pagehide\`, flushed ` +
      `unconditionally) left the server holding ${row.serverAfterANavigatedMs}ms against a ` +
      `furthest-heard of ${row.furthestMs}ms. A tab being closed must not publish the position ` +
      "it happened to be sitting on over another device's newer one.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);
});

/**
 * X3 — the finding this axis was added to look for, and it is RED.
 *
 * Kept as its own test on purpose. It is not a weaker or stricter version of
 * X2; it is a different requirement that the same journey answers differently,
 * and folding it into X2 would let one verdict hide the other.
 *
 * MEASURED, HEAD `8afb574`, WebKit: device A listens to 6815 ms and its tab is
 * left open. Device B takes the book to 15693 ms; the server correctly holds
 * that, and X2 passes on every clobber assertion. Then A's tab is navigated
 * away from — closing it, or following any link, does the same thing — and the
 * unconditional `pagehide` flush rewrites A's OWN durable local record: same
 * stale position, 6815 ms, with a brand new `occurredAt` (measured: the stamp
 * moved 15.4 s forward while the position did not move at all).
 *
 * That fresh stamp is what `localWinsOver` reads. So when the user comes back
 * to device A the local record beats the server's newer cross-device position,
 * and A resumes 8878 ms behind where they actually got to — nine seconds of
 * device B's listening silently discarded, with no user input.
 *
 * This is the LOST-PROGRESS twin of the skip-ahead the same commit fixed on the
 * visible edge, on the edge that was deliberately left unconditional. The
 * server is NOT clobbered (`clobberedByPagehideMs: 0`, measured), so other
 * devices stay correct; the damage is confined to the tab that was left open,
 * which is also the tab the user is most likely to come back to.
 *
 * It is left failing rather than annotated away. A bar is not moved for it and
 * no check is skipped.
 */
test("X3: closing a stale tab must not discard another device's newer listening", async () => {
  test.setTimeout(900_000);
  const row = await theTwoDeviceRun();

  expect(
    row.deviceALostMs - row.rewindCreditedA,
    `X3: device A came back at ${row.deviceAResumedMs}ms against a furthest-heard of ` +
      `${row.furthestMs}ms — ${row.deviceALostMs}ms behind, of which only ` +
      `${row.rewindCreditedA}ms is smart rewind. The mechanism is in the row: A's durable local ` +
      `record went from ${JSON.stringify(row.localABeforeNav)} to ` +
      `${JSON.stringify(row.localAAfterNav)} across its own navigation — the same stale ` +
      "position with a brand new `occurredAt`, written by the unconditional `pagehide` flush. " +
      "`localWinsOver` then prefers it over the server's newer cross-device position, so the " +
      "listening the user did on device B is thrown away on device A. The server itself was " +
      `not clobbered (it still holds ${row.serverAfterANavigatedMs}ms), so this is confined to ` +
      "the tab that was left open.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);
});
