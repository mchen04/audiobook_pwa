import { expect, test } from "@playwright/test";

import {
  AHEAD_BAR_MS,
  CALLBACK_BAR_MS,
  closeResumeFixture,
  measure,
  measureCrossBookAbsence,
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

/**
 * ONE BOOK PER SCENARIO. Nothing here shares a book with anything else.
 *
 * The rows used to share three books, which coupled them in a way that only
 * showed up in a full pass: a book is a single entry in this device's download
 * store and a single set of bytes in Cache Storage, so one scenario losing that
 * entry took the book away from every later scenario that used it. Measured, on
 * the three-book matrix: C2 and X1 failed at their FIRST `openPlayer` with "this
 * device does not currently have it", for a book damaged four scenarios earlier,
 * while both passed standalone. `preflightDevice` now catches that at the moment
 * it happens rather than where it surfaces, but the coupling itself is worth
 * removing: a shared book also means each row starts wherever the last one left
 * off, which is why several of them had to ask for `resetBookFirst`.
 *
 * The cost is import time and disk, and both are cheap. MEASURED, WebKit
 * ephemeral context, `navigator.storage.estimate()`: quota 1_048_576_000 bytes,
 * and 200 x 98 KB entries written and read back with no error. The "WebKit
 * refuses to hold more than a few hundred kilobytes" note this file used to
 * carry was wrong — it belonged to the persistent-context setup that could not
 * host the app at all.
 */
const SCENARIOS: ScenarioSpec[] = [
  { scenario: "T1 hidden online", bookIndex: 0, termination: "hidden", network: "online" },
  { scenario: "T1 hidden offline", bookIndex: 1, termination: "hidden", network: "offline" },
  { scenario: "T2 pagehide online", bookIndex: 2, termination: "pagehide", network: "online" },
  { scenario: "T2 pagehide offline", bookIndex: 3, termination: "pagehide", network: "offline" },
  { scenario: "T3 hardkill online", bookIndex: 4, termination: "hard-kill", network: "online" },
  { scenario: "T4 reload online", bookIndex: 5, termination: "reload", network: "online" },
  // T5 was "leave the player" on its own. It is N/A-BY-DESIGN and is replaced
  // below; see `T5_RETIRED_RATIONALE`.
  {
    scenario: "T6 nav then hardkill online",
    bookIndex: 6,
    termination: "nav-then-hard-kill",
    network: "online",
    openFromLibrary: true,
  },
  {
    scenario: "T7 nav then pagehide online",
    bookIndex: 7,
    termination: "nav-then-pagehide",
    network: "online",
    openFromLibrary: true,
  },
];

/**
 * T5 — "leave the player" — is retired as N/A-BY-DESIGN, not relaxed.
 *
 * Leaving the player keeps audio playing ON PURPOSE: commits 548623c and
 * f787e8e deliberately keep one library UI with the player alive while the user
 * browses. So the in-app navigation terminates nothing, nothing is ever
 * restored, and applying a 250 ms RESUME bar to it grades a session that never
 * ended — it produced a 1109 ms "resumed AHEAD" reading, the most serious
 * verdict this suite has, for a build whose stored position was exactly right.
 * Making back stop playback to satisfy the oracle would silently reverse a
 * product decision, so the row is retired and REPLACED by T6/T7, which perform
 * the same navigation and THEN apply a termination this build really does treat
 * as one. Net coverage goes up: the journey "I hit back, then iOS took the tab"
 * was previously untested by anything.
 *
 * Whether back SHOULD stop playback is `tests/parity/player-back.spec.ts`'s
 * question. This suite only measures resume.
 */
const T5_RETIRED_RATIONALE =
  "T5 (bare in-app navigation) is N/A-by-design: it is not a termination on this build.";

/**
 * The book index whose fixture is built long, and how long.
 *
 * C4 grades the ladder's top tier, which subtracts 30 s. A ~24 s book cannot
 * hold that: the position bottoms out at zero on the first open and every later
 * cycle reads a clean 0 ms delta, so the tier is not merely awkward to measure,
 * it is unmeasurable — which is why C3's comment recorded the upper tiers as
 * UNREACHABLE rather than faking them. Fifteen copies of the fixture's frames
 * is ~120 s, which leaves a 65 s listen sitting 35 s clear of the floor after
 * the rewind, so a per-cycle walk has somewhere to show itself.
 */
const FIVE_MINUTE_BOOK_INDEX = 10;
const TOP_TIER_BOOK_INDEX = 11;
const LONG_BOOK_REPEAT = 15;

const CUMULATIVE = [
  { scenario: "C1 cycles online", bookIndex: 8, network: "online" as const, cycles: 5 },
  { scenario: "C2 cycles offline", bookIndex: 9, network: "offline" as const, cycles: 5 },
  /**
   * C3 is the cell C1/C2 only LOOKED like they covered.
   *
   * C1/C2 run their cycles back to back in seconds. `rewindForAbsence` returns
   * 0 below 60_000 ms, so those rows never enter the smart-rewind branch at all
   * and their 0 ms result says nothing about the compounding backward walk they
   * were written to catch. C3 puts a real absence between every cycle, which
   * makes each open apply a genuine rewind, and then demands that the position
   * still not walk backwards across the cycles.
   *
   * 300_000 ms picks the 5 s rewind tier deliberately. This row also gets a
   * long fixture: WebKit can spend several seconds between the requested play
   * interval and the pause taking effect under a loaded full-matrix run. With
   * a ~24 s book that instrumentation latency can put the saved position inside
   * `BOOK_END_EPSILON_MS`, where reopening correctly restarts a finished book
   * from zero and leaves no anchor to grade. A ~120 s book keeps the row far
   * from that unrelated boundary while preserving the same rewind tier and
   * bars. Measured under
   * `HARK_RESUME_POISON=persist-rewound-start`: per-cycle [0,5000,2806,0,0],
   * total 7806 against a 250 ms bar.
   */
  {
    scenario: "C3 cycles online, 5min absence each",
    bookIndex: FIVE_MINUTE_BOOK_INDEX,
    network: "online" as const,
    cycles: 5,
    playMs: 12_000,
    absenceBetweenCyclesMs: 300_000,
  },
  /**
   * C4 closes the tier C3 could only name.
   *
   * C3 deliberately grades the 5 s tier and records the two above it as
   * UNREACHABLE, because a 24 s book has no room for a 30 s subtraction. That
   * is a fixture limit, not a product one, so it is removed by giving this row
   * a ~120 s book (`TOP_TIER_BOOK_INDEX`) and a 65 s listen. An absence of 65
   * minutes puts it past the ladder's one-hour threshold, so every cycle
   * credits the full 30 s — asserted, not assumed, by `assertCumulativeMeasured`
   * — and the anchor lands around 35 s, comfortably clear of the floor, so a
   * per-cycle walk backwards has somewhere to go and would be seen.
   *
   * This is the tier a real user meets most often: the one where they come back
   * to a book the next day.
   */
  {
    scenario: "C4 cycles online, 65min absence each",
    bookIndex: TOP_TIER_BOOK_INDEX,
    network: "online" as const,
    cycles: 5,
    playMs: 65_000,
    absenceBetweenCyclesMs: 65 * 60_000,
  },
];

/** One book per scenario, plus the two X1 needs. See `SCENARIOS`. */
const BOOK_COUNT = 14;

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
  await resumeFixture(BOOK_COUNT, {
    [FIVE_MINUTE_BOOK_INDEX]: LONG_BOOK_REPEAT,
    [TOP_TIER_BOOK_INDEX]: LONG_BOOK_REPEAT,
  });
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
  if (row.termination === "hard-kill" || row.termination === "nav-then-hard-kill") {
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

/**
 * A verdict may never be stronger than the evidence behind it.
 *
 * This is what T7 got wrong for a whole matrix pass. An in-app navigation
 * DESTROYS the audio element, and the row's fallback true position was then the
 * last value the DRIVING PROCESS had sampled — before the navigation started,
 * while the element went on playing throughout it. That is a LOWER bound, and
 * the row's own notes said so:
 *
 *   "its currentTime collapsed to 0ms from a sampled 18998ms, so its value is
 *    not evidence of anything ... which is a LOWER bound"
 *
 * and then it applied the AHEAD bar — "content the user paid for, silently
 * skipped", the harshest verdict this suite has — to the gap between that lower
 * bound and where the app came back. MEASURED: startedAt 9155 + played 9657 =
 * 18812 sampled against a resume of 20387, reported as a 1389 ms blocker for a
 * build that had skipped nothing; the gap is the navigation's own duration.
 *
 * The instrument now establishes real ground truth instead: `PROBE_SCRIPT`
 * samples the element from inside the page every 50 ms and keeps the last
 * observation taken while it was alive, unpaused and past zero, so the value
 * graded against is at most 50 ms — a fifth of the bar — older than the
 * element's death. `groundTruth: "teardown-probe"` is that case.
 *
 * When even that produces nothing, the row is UNCOVERED. It is NOT graded, and
 * it is NOT silently passed: a resume ahead of a lower bound is not evidence of
 * a skip, and a bound of unknown size is not evidence of anything.
 */
function assertGroundTruthIsReal(row: Row): void {
  expect(
    row.groundTruth,
    `${row.scenario}: UNCOVERED. The termination destroyed the audio element and the in-page ` +
      `probe produced no usable witness (${row.teardownWitnessSamples} samples, last ` +
      `${row.teardownWitnessMs}ms). All this row knows is that the user had reached ` +
      `${row.truePositionMs}ms, which is a LOWER bound — the element kept playing for the length ` +
      `of the navigation before it died. The app came back at ${row.resumedPositionMs}ms and the ` +
      `shelf held ${row.shelf.sourceMs}ms, both recorded; but grading a resume against a lower ` +
      "bound would report the navigation's own duration as content the user paid for and never " +
      "heard. Cover this cell with a probe that survives the teardown, not with a wider bar.",
  ).not.toBe("lower-bound");
}

for (const spec of SCENARIOS) {
  test(`${spec.scenario}: resumes where the user left off`, async () => {
    test.setTimeout(300_000);
    const row = await measure(spec);
    recordRow(row);

    assertMeasured(row);
    assertLifecycle(row);
    assertHiddenIsReal(row);
    assertGroundTruthIsReal(row);

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
  // An absence row that credited no rewind graded the same 0 ms tier the plain
  // cumulative rows already grade, and would be a duplicate wearing a new name.
  if (row.absenceBetweenCyclesMs !== null) {
    expect(
      Math.min(...row.rewindObserved),
      `${row.scenario}: at least one cycle entered with a rewind of 0ms despite a ` +
        `${row.absenceBetweenCyclesMs}ms absence (${JSON.stringify(row.rewindObserved)}). This ` +
        "row would then be grading the same branch C1/C2 already grade — a vacuous pass.",
    ).toBeGreaterThan(0);
    // There has to be somewhere to walk TO. A rewind that bottoms out at zero
    // on the first cycle reports a clean 0 ms delta for every cycle after it,
    // because there was nowhere left to go — the position at the anchor must
    // leave room for at least one full rewind to be visible. (The total still
    // catches a walk that bottoms out later: `anchor - 0` is far past the bar.)
    expect(
      row.anchorMs,
      `${row.scenario}: the anchor is ${row.anchorMs}ms and a single cycle's rewind is ` +
        `${row.rewindObserved[0]}ms, so the rewind bottoms out immediately and no per-cycle ` +
        "movement could be observed at all",
    ).toBeGreaterThan(row.rewindObserved[0]!);
  }
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

    // Reported as its own column, not folded into the total: a walk that is
    // steady and small reads differently from one cycle that lost everything,
    // and the two need different fixes.
    expect(
      Math.max(...row.perCycleDeltaMs),
      `${row.scenario}: one open with no listening lost ` +
        `${Math.max(...row.perCycleDeltaMs)}ms on its own ` +
        `(per-cycle ${JSON.stringify(row.perCycleDeltaMs)}, positions ` +
        `${JSON.stringify(row.positions)}, rewind credited per cycle ` +
        `${JSON.stringify(row.rewindObserved)})`,
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

/**
 * X1: an absence from one book must not move another.
 *
 * The pause marker used to be one global key with no user and no book in it, so
 * "you have been away for an hour" was a property of the DEVICE. A user who
 * finished book A last month and has been listening to book B every night would
 * have B rewound on open because of A. This is the direct test of that, and it
 * is separate from C3 because C3 could pass on a per-user-but-not-per-book key.
 */
test("X1: an absence from one book does not rewind another", async () => {
  test.setTimeout(600_000);
  const row = await measureCrossBookAbsence({
    scenario: "X1 cross-book absence",
    absentBookIndex: 12,
    otherBookIndex: 13,
    /**
     * 90 minutes puts the ABSENT book on the ladder's top rung (30 s), which is
     * two rungs clear of anything the untouched book can reach on its own while
     * this row runs — it is paused for a couple of minutes at most, so 5 s, and
     * 15 s even if the machine crawls. The gap is what makes a leak visible
     * after the untouched book's own credit is subtracted; the precondition
     * below refuses to grade the row if it ever closes.
     */
    absenceMs: 90 * 60_000,
    playMs: 12_000,
  });
  recordRow(row);

  expect(row.ticks, "X1: nothing played, so nothing was measured").toBeGreaterThan(2);
  expect(row.otherStoredMs, "X1: the untouched book had no ground to hold").toBeGreaterThan(4_000);

  /**
   * THE LEAK HAS TO BE DISTINGUISHABLE FROM THE UNTOUCHED BOOK'S OWN ABSENCE.
   *
   * The untouched book is paused while the user listens to the other one, so it
   * accrues an absence of its own and the ladder credits it honestly. That
   * credit is subtracted below. If the two absences ever landed on the SAME
   * rung, subtracting one would hide the other and the row would pass without
   * being able to see the thing it exists to see — so the rungs are required to
   * differ, and the row is UNCOVERED rather than green if they do not.
   */
  expect(
    row.rewindIfLeakedMs,
    `X1: UNCOVERED. The absent book's absence credits ${row.rewindIfLeakedMs}ms and the untouched ` +
      `book's own absence (${row.otherOwnAbsenceMs}ms) credits ${row.otherOwnRewindMs}ms — the ` +
      "same rung. A leak of exactly that size would be indistinguishable from the untouched " +
      "book's own legitimate rewind, so this row could not see the defect it exists for. Give " +
      "the absent book a longer absence, or the untouched book a shorter one.",
  ).toBeGreaterThan(row.otherOwnRewindMs);

  expect(
    row.leakedRewindMs - row.otherOwnRewindMs,
    `X1: "${row.otherBookTitle}" was stored at ${row.otherStoredMs}ms and opening it came back at ` +
      `${row.otherResumedMs}ms — ${row.leakedRewindMs}ms of movement, of which only ` +
      `${row.otherOwnRewindMs}ms is the rewind it earned itself (its own marker is ` +
      `${row.otherOwnAbsenceMs}ms old). The remainder is rewind that belongs to ` +
      `"${row.absentBookTitle}", which the user has been away from for ${row.absenceMs}ms and for ` +
      `which the ladder credits ${row.rewindIfLeakedMs}ms. Marker keys on the device: ` +
      `${JSON.stringify(row.markerKeysSeen)}.`,
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);
});

test("T5 stays retired, and its replacements stay in the matrix", () => {
  expect(
    SCENARIOS.some((spec) => spec.termination === "in-app-nav"),
    `${T5_RETIRED_RATIONALE} A bare in-app-navigation row is back in the matrix: the audio ` +
      "survives that navigation by design, so a resume bar applied to it grades a session that " +
      "never ended. Use nav-then-hard-kill or nav-then-pagehide.",
  ).toBe(false);
  expect(
    SCENARIOS.filter((spec) => spec.termination.startsWith("nav-then-")).length,
    `${T5_RETIRED_RATIONALE} Its composed replacements have been removed, which turns a ` +
      "reclassification into a net LOSS of coverage.",
  ).toBeGreaterThanOrEqual(2);
});
