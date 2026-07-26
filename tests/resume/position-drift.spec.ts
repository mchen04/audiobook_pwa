import { expect, test } from "@playwright/test";

import {
  AHEAD_BAR_MS,
  closeResumeFixture,
  measure,
  measureCumulative,
  recordRow,
  resumeFixture,
  type CumulativeRow,
  type Row,
  type ScenarioSpec,
} from "./harness/resume-oracle";

/**
 * Does the app come back exactly where the user left off?
 *
 * The bars (frozen; a fix may make them stricter, never looser):
 *   - a lifecycle callback WAS delivered (background, pagehide, reload, in-app
 *     navigation): drift <= 250 ms
 *   - no callback at all (SIGKILL): drift <= 1000 ms
 *   - offline is held to the SAME bar as online
 *   - resuming AHEAD of the user is a blocker at any magnitude, separately
 *     asserted, because it silently skips content
 *
 * Every row also grades the SHELF, because "the resume position is behind" is
 * something the user sees on the library card before they ever press play.
 *
 * Read `harness/resume-oracle.ts` for how the true position is obtained; the
 * short version is that it is sampled off the audio element by the driving
 * process and never taken from the app.
 */

const SCENARIOS: ScenarioSpec[] = [
  { scenario: "T1 hidden online", bookIndex: 0, termination: "hidden", network: "online" },
  { scenario: "T1 hidden offline", bookIndex: 1, termination: "hidden", network: "offline" },
  { scenario: "T2 pagehide online", bookIndex: 2, termination: "pagehide", network: "online" },
  { scenario: "T2 pagehide offline", bookIndex: 0, termination: "pagehide", network: "offline" },
  { scenario: "T3 hardkill online", bookIndex: 1, termination: "hard-kill", network: "online" },
  { scenario: "T4 reload online", bookIndex: 2, termination: "reload", network: "online" },
  {
    scenario: "T5 nav online",
    bookIndex: 0,
    termination: "in-app-nav",
    network: "online",
    openFromLibrary: true,
  },
];

const CUMULATIVE = [
  { scenario: "C1 cycles online", bookIndex: 1, network: "online" as const, cycles: 5 },
  { scenario: "C2 cycles offline", bookIndex: 2, network: "offline" as const, cycles: 5 },
];

/** Three books is what WebKit's Cache Storage would hold; see `ScenarioSpec`. */
const BOOK_COUNT = 3;

/**
 * Sequential, but NOT `mode: "serial"`.
 *
 * The scenarios share one profile and one set of books, so they must run in
 * order and in one worker — which `playwright.config.ts` already guarantees
 * (`fullyParallel: false`, `workers: 1`). `mode: "serial"` would add one more
 * thing on top: the moment any scenario fails, every scenario after it is
 * SKIPPED. This is a measurement matrix. The first red cell is the least
 * interesting thing in it, and a matrix that stops at the first failure reports
 * eight unmeasured cells as silence — which is the one outcome this ledger
 * refuses to allow.
 */

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await resumeFixture(BOOK_COUNT);
});

test.afterAll(async () => {
  await closeResumeFixture();
});

/** Liveness: a row that measured nothing must never read as a clean zero. */
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
  expect(
    row.resumedPositionMs,
    `${row.scenario}: no position could be read after the relaunch`,
  ).toBeGreaterThanOrEqual(0);
}

function assertLifecycle(row: Row): void {
  const kinds = row.lifecycle.map((entry) => entry.split("@")[0]);
  if (row.termination === "hard-kill") {
    expect(
      kinds,
      `${row.scenario}: a lifecycle callback WAS delivered, so this is not the no-callback case ` +
        "the 1000ms bar is for",
    ).toStrictEqual([]);
  } else {
    expect(
      kinds.length,
      `${row.scenario}: the lifecycle callback this row is named after never fired, so the 250ms ` +
        "bar is being applied to a case that did not happen",
    ).toBeGreaterThan(0);
  }
}

/**
 * T1 claims to be "the app was backgrounded". It may only be graded as a pass
 * when the PLATFORM actually reported the page as hidden.
 *
 * Dispatching a `visibilitychange` event at a page whose `visibilityState` is
 * still `"visible"` fakes the notification without the state, and a build that
 * flushes on the event would go green while the real iOS background path stayed
 * broken — a vacuous pass on the single most important cell in this matrix. The
 * harness overrides `visibilityState` before dispatching so the app's handler at
 * least observes what it would observe for real, and it attempts a genuine
 * backgrounding first on every run; but "attempted and could not" is an honest
 * gap, not a pass, and this is what says so out loud.
 */
function assertHiddenIsReal(row: Row): void {
  if (row.termination !== "hidden") return;
  expect(
    row.hiddenTransition,
    `${row.scenario}: UNCOVERED. This engine cannot background a page for real — measured, ` +
      'Playwright/WebKit leaves visibilityState at "visible" through a second page and ' +
      "bringToFront, and exposes no activity-state control — so the hidden state was " +
      `synthesised (the page's handler read "${row.visibilityAtCallback}"). The drift this row ` +
      `measured is ${row.driftMs}ms against a ${row.barMs}ms bar and the shelf was ` +
      `${row.shelfDriftMs}ms off, both recorded for the ledger; but a synthesised state does ` +
      "not exercise the iOS background path, so this cell is a GAP, not a green. Covering it " +
      "needs an engine that can genuinely report a hidden page, or real hardware.",
  ).toBe("real");
}

for (const spec of SCENARIOS) {
  test(`${spec.scenario}: resumes where the user left off`, async () => {
    test.setTimeout(300_000);
    const row = await measure(spec);
    recordRow(row);

    assertMeasured(row);
    assertLifecycle(row);
    assertHiddenIsReal(row);

    // A termination that did not terminate anything grades as UNCOVERED, never
    // as a pass and never as a product blocker. The audio element surviving an
    // in-app navigation means nothing was restored, so `resumed - true` is the
    // oracle timing a session that never stopped: it produced a 925 ms "resumed
    // AHEAD" reading — the most serious verdict this suite has — for a build
    // whose own stored position matched what it came back at exactly.
    expect(
      row.sessionSurvived,
      `${row.scenario}: UNCOVERED. This termination did not end the listening session (the audio ` +
        "element survived it and was still playing), so nothing was restored and this row says " +
        `nothing about resume. Raw, for the record: true ${row.truePositionMs}ms, came back at ` +
        `${row.resumedPositionMs}ms, the app's own stored value ${row.shelf.localMs}ms. Cover T5 ` +
        "with a termination this build treats as one.",
    ).toBe(false);

    // Skipping content is a blocker at any magnitude and gets no rewind credit.
    expect(
      row.aheadMs,
      `${row.scenario}: the app resumed ${row.aheadMs}ms AHEAD of where the user was. That is ` +
        "content the user paid for, silently skipped.",
    ).toBeLessThanOrEqual(AHEAD_BAR_MS);

    // The player.
    expect(
      row.driftMs,
      `${row.scenario}: resumed ${row.behindMs}ms behind the true position ` +
        `(true ${row.truePositionMs}ms, resumed ${row.resumedPositionMs}ms, intended rewind ` +
        `${row.expectedRewindMs}ms, ${row.ticks} ticks over ${row.playedMs}ms of playback)`,
    ).toBeLessThanOrEqual(row.barMs);

    // The shelf, read before the player was opened on this relaunch and from a
    // different path than the audio element. Same bar: the user sees this one
    // first, and a stale card is the complaint in its own right.
    expect(
      row.shelf.sourceMs,
      `${row.scenario}: the shelf had no position for this book at all`,
    ).not.toBeNull();
    expect(
      row.shelfDriftMs,
      `${row.scenario}: the library card was ${row.shelfDriftMs}ms off the true position ` +
        `(card showed ${row.shelf.percent}% / "${row.shelf.statusText}", underlying value ` +
        `${row.shelf.sourceMs}ms, true ${row.truePositionMs}ms)`,
    ).toBeLessThanOrEqual(row.barMs);

    // The rendered percent must agree with the value it is rendered from, or
    // the card is lying about its own data.
    if (row.shelf.impliedMs !== null && row.shelf.sourceMs !== null) {
      expect(
        Math.abs(row.shelf.impliedMs - row.shelf.sourceMs),
        `${row.scenario}: the rendered progress bar disagrees with the position behind it`,
      ).toBeLessThanOrEqual(row.shelf.quantumMs + 1);
    }

    // The session, not just the number.
    expect(row.titleAfter, `${row.scenario}: a different book came back`).toContain(row.bookTitle);
    expect(
      row.playbackRateAfter,
      `${row.scenario}: the playback rate was not restored`,
    ).toBeCloseTo(row.playbackRateBefore, 2);
    expect(
      row.completedAfter,
      `${row.scenario}: the book was marked finished by being interrupted mid-listen`,
    ).not.toBe(true);
    if (row.expectedChapter) {
      expect(row.chapterAfter ?? row.expectedChapter, `${row.scenario}: wrong chapter`).toContain(
        row.expectedChapter,
      );
    }

    // Offline must not be worse than online, and nothing recorded offline may
    // be silently dropped: `measure()` already waited for the server to receive
    // it, this pins the value.
    if (spec.network === "offline") {
      expect(
        row.serverPositionMs,
        `${row.scenario}: progress recorded offline reached the server as ` +
          `${row.serverPositionMs}ms, not the position the user was at`,
      ).toBeGreaterThan(row.truePositionMs - row.barMs - 5_000);
    }
  });
}

/** Liveness for the cumulative rows. */
function assertCumulativeMeasured(row: CumulativeRow): void {
  expect(row.ticks, `${row.scenario}: nothing played, so nothing was measured`).toBeGreaterThan(2);
  expect(row.anchorMs, `${row.scenario}: no ground was established to hold`).toBeGreaterThan(4_000);
  expect(row.positions.length, `${row.scenario}: no cycles ran`).toBe(row.cycles);
}

for (const spec of CUMULATIVE) {
  test(`${spec.scenario}: ${spec.cycles} opens with no listening lose no ground`, async () => {
    test.setTimeout(600_000);
    const row = await measureCumulative(spec);
    recordRow(row);
    assertCumulativeMeasured(row);

    // The total is the assertion that matters. Five cycles that each pass the
    // per-cycle bar while the book walks backwards by minutes is a failure the
    // per-cycle view reports as green.
    expect(
      Math.abs(row.totalDriftMs),
      `${row.scenario}: after ${row.cycles} opens with no listening the position moved ` +
        `${row.totalDriftMs}ms (anchor ${row.anchorMs}ms, cycles ${JSON.stringify(row.positions)}, ` +
        `per-cycle ${JSON.stringify(row.perCycleDeltaMs)}). Smart rewind is NOT subtracted here: ` +
        "a rewind that re-applies on every open is this failure, not an allowance.",
    ).toBeLessThanOrEqual(row.barMs);

    if (row.shelfTotalDriftMs !== null) {
      expect(
        Math.abs(row.shelfTotalDriftMs),
        `${row.scenario}: the shelf's position moved ${row.shelfTotalDriftMs}ms across ` +
          `${row.cycles} opens with no listening (${JSON.stringify(row.shelfPositions)})`,
      ).toBeLessThanOrEqual(row.barMs);
    }
  });
}
