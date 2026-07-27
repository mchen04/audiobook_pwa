import { expect, test } from "@playwright/test";

import {
  AHEAD_BAR_MS,
  CALLBACK_BAR_MS,
  closeResumeFixture,
  measureSuspensionRecovery,
  recordRow,
  resumeFixture,
  type RecoveryRow,
} from "./harness/resume-oracle";

/**
 * The one durability question this machine cannot answer, and the safety net
 * that makes it not matter.
 *
 * THE QUESTION (`docs/resume-durability-device-check.md`, nine avenues probed
 * and measured closed): while the PWA is backgrounded with the screen off and
 * audio playing, does iOS suspend BOTH the 200 ms cadence timer AND the media
 * element's `timeupdate`? Playwright's WebKit never reports a page as genuinely
 * hidden, `setActivityState` does not exist in `playwright-core`, macOS Safari
 * does not reproduce iOS's background suspension, and the Simulator needs Xcode.
 * So the question stays open on this machine and `assertHiddenIsReal` keeps
 * saying so.
 *
 * THE CONSEQUENCE IF THE ANSWER IS YES is already measured: with both writers
 * dead, `uncovered-axes`' control row loses 9644 ms across a 9500 ms session —
 * 100% of it, scaling linearly. A long screen-off listen would lose the whole
 * thing.
 *
 * WHAT THESE ROWS ARE. Not an attempt to answer the question. They measure the
 * SAFETY NET, which is entirely measurable here: given the exact signature a
 * suspended session leaves behind, does the app (a) come back at the recorded
 * position and NEVER ahead of it, (b) offer the user a labelled estimate of
 * where the audio would have got to, and (c) shut up about it once told to?
 * And, the row that stops this from being an everyday annoyance: (d) does it
 * stay silent after an ORDINARY backgrounding, where the writers did their job?
 *
 * If iOS never suspends anything, none of this ever fires — the detection
 * requires that no later write exist, and a surviving writer makes one. R2 is
 * the row that proves that half.
 *
 * ADDITIVE. Nothing here modifies, relaxes or shares a book with
 * `position-drift.spec.ts` or `uncovered-axes.spec.ts`.
 */

const BOOK_COUNT = 3;

/**
 * The size of the unrecorded stretch these rows grade.
 *
 * Two minutes: twice the app's own 60 s floor, so R1 cannot pass by a hair, and
 * far enough above the few seconds a relaunch costs that R2 cannot fail by one
 * either. The gap is SET by the harness, not waited out, so it is exact — see
 * `ageSuspensionWrite` for why moving the clock is the only honest way to reach
 * the size of a real screen-off listen inside a test.
 */
const GAP_MS = 120_000;

/**
 * R1 and R3 need a book with room to project INTO.
 *
 * The projection is clamped to the duration, and correctly so — but a row whose
 * projection saturates the clamp grades the clamp rather than the extrapolation
 * (the clamp is covered exhaustively in `playback-core.test.ts`). An ordinary
 * fixture book is ~24 s against a 120 s gap, so it would clamp instantly. Each
 * repeat is ~8 s, so 25 of them is ~200 s: about 8 s of playback plus a 120 s
 * projection lands near 129 s, roughly 70 s clear of the end.
 *
 * R2 GETS THE LONG BOOK TOO, and not for symmetry. Its fail-demo
 * (`HARK_RESUME_POISON=recovery-always-offers`) forges a five-minute gap into
 * the record, and on a ~24 s book that projection clamps to the end and leaves
 * an advance under the app's 60 s floor — so the poisoned run would produce no
 * offer and R2 would stay green against the very regression it exists to catch.
 * A row whose fail-demo cannot fire is not graded. MEASURED: the first version
 * of these rows gave R2 a 24137 ms book for exactly that reason.
 */
const LONG_BOOK_REPEAT = 25;

test.beforeAll(async () => {
  test.setTimeout(900_000);
  await resumeFixture(BOOK_COUNT, {
    0: LONG_BOOK_REPEAT,
    1: LONG_BOOK_REPEAT,
    2: LONG_BOOK_REPEAT,
  });
});

test.afterAll(async () => {
  await closeResumeFixture();
});

/** Refuses to grade a row whose session never happened. */
function assertMeasured(row: RecoveryRow): void {
  expect(row.ticks, `${row.scenario}: no timeupdate ticks — nothing was measured`).toBeGreaterThan(
    2,
  );
  expect(
    row.playedMs,
    `${row.scenario}: the position advanced by ${row.playedMs}ms, which is not a listening ` +
      "session. A row from a player that never played is not a pass.",
  ).toBeGreaterThan(4_000);
  expect(
    row.lifecycle.map((entry) => entry.split("@")[0]),
    `${row.scenario}: the platform delivered no lifecycle callback at all, so the hide-edge write ` +
      "this row is about could never have happened",
  ).not.toStrictEqual([]);
}

/**
 * The signature, asserted as a fact about the record rather than assumed.
 *
 * There is ONE durable record per (user, book) and every write overwrites it,
 * so `source` still naming the hide edge is the whole detection rule: nothing
 * wrote after the app went away. This row produces that by deleting both
 * cadence writers — the same poisons that produce the 9644 ms control — and
 * then letting the app take its own hide edge with the audio still running.
 */
function assertSuspensionSignature(row: RecoveryRow): void {
  expect(
    row.writersBlocked,
    `${row.scenario}: the harness dropped no "setTimeout:200" registration, so the 200ms cadence ` +
      `timer was never deleted (dropped: ${JSON.stringify(row.writersBlocked)}) and this row is ` +
      "measuring an ordinary build",
  ).toContain("setTimeout:200");
  expect(
    row.writersBlocked,
    `${row.scenario}: the harness dropped no "timeupdate" registration, so the media-tick writer ` +
      "was never deleted and this row is measuring an ordinary build",
  ).toContain("timeupdate");
  expect(
    row.recordAfterKill.source,
    `${row.scenario}: with both cadence writers deleted, the last durable write should be the ` +
      `hide-edge flush — it was "${row.recordAfterKill.source}". Either a writer survived the ` +
      "poison, or the flush never ran, and either way there is no suspension signature here.",
  ).toBe("visibility-flush");
  expect(
    row.recordAfterKill.playingAtWrite,
    `${row.scenario}: the hide-edge record does not say audio was live, so nothing can tell this ` +
      "apart from a book backgrounded while paused",
  ).toBe(true);
  expect(
    row.recordAfterKill.writtenAt,
    `${row.scenario}: the hide-edge record carries no write timestamp, so the size of the ` +
      "unrecorded stretch is unknowable",
  ).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// R1 — the exact suspension signature, seeded and relaunched
// ---------------------------------------------------------------------------

test("R1: the app resumes where it saved, never forward, and offers the estimate", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R1 suspended session, recovery offered",
    bookIndex: 0,
    killCadenceWriters: true,
    gapMs: GAP_MS,
  });
  recordRow(row);
  assertMeasured(row);
  assertSuspensionSignature(row);

  const recordedMs = row.recordAfterKill.positionMs!;

  /**
   * The book has to have room for the projection, or this row grades the clamp
   * instead of the extrapolation and its numbers say nothing about the
   * arithmetic. An instrument precondition, checked rather than assumed.
   */
  expect(
    recordedMs + GAP_MS,
    `${row.scenario}: a ${GAP_MS}ms projection from ${recordedMs}ms runs off the end of a ` +
      `${row.durationMs}ms book, so the offer below would be clamped to the end and this row ` +
      "would grade the clamp rather than the projection. The fixture book is too short.",
  ).toBeLessThan(row.durationMs - 5_000);

  /**
   * THE BLOCKER RULE, and the first thing graded. Skipping content the user
   * never heard is a blocker in this codebase at any magnitude, and an
   * extrapolation is the most tempting way to do it: the app knows the audio
   * *probably* ran on for the whole gap. It must not act on that. The saved
   * position stays the source of truth and the player comes back there.
   */
  expect(
    row.resumedAheadOfRecordMs,
    `${row.scenario}: the app came back ${row.resumedAheadOfRecordMs}ms AHEAD of the position it ` +
      `saved (record ${recordedMs}ms, resumed ${row.resumedPositionMs}ms). The projected point ` +
      `was ${row.offer.projectedMs}ms; applying it without the user pressing anything skips ` +
      "content they never heard, and would be simply wrong if iOS had stopped the audio early.",
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
  expect(
    Math.abs(row.resumedAheadOfRecordMs! + row.expectedRewindMs),
    `${row.scenario}: the app resumed ${row.resumedPositionMs}ms against a saved ${recordedMs}ms ` +
      `(rewind due: ${row.expectedRewindMs}ms). The recorded position is the source of truth and ` +
      "the player has to come back at it.",
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);

  // THE AFFORDANCE. Present, and present as an offer rather than an obstacle.
  expect(
    row.offer.shown,
    `${row.scenario}: the app came back ${recordedMs}ms with ${GAP_MS}ms of listening it could ` +
      "not record, and said nothing about it. That is the case this whole path exists for.",
  ).toBe(true);
  expect(row.offer.role, `${row.scenario}: the offer is not announced politely`).toBe("status");
  expect(
    row.offer.modal,
    `${row.scenario}: the offer is a modal, so it blocks the player behind it`,
  ).toBe(false);
  expect(
    row.offer.transportUsable,
    `${row.scenario}: the transport is not usable with the offer on screen, so the offer is ` +
      "blocking playback",
  ).toBe(true);
  expect(
    row.offer.dismissLabel,
    `${row.scenario}: the offer has no dismiss control, so the user cannot say no to it`,
  ).not.toBeNull();
  expect(
    row.offer.jumpLabel,
    `${row.scenario}: the jump control does not say the estimate is an estimate ` +
      `("${row.offer.jumpLabel}")`,
  ).toMatch(/about/i);

  // ------------------------------------------------- is the estimate correct?

  expect(
    row.offer.recordedMs,
    `${row.scenario}: the offer is built on ${row.offer.recordedMs}ms, which is not the position ` +
      `the app actually saved (${recordedMs}ms)`,
  ).toBe(recordedMs);
  expect(
    row.offer.playbackRate,
    `${row.scenario}: the offer used rate ${row.offer.playbackRate} against a record written at ` +
      `${row.recordAfterKill.playbackRate}`,
  ).toBe(row.recordAfterKill.playbackRate);

  /**
   * The elapsed time, bounded from BOTH sides against numbers the harness owns
   * rather than against the app's own arithmetic. The clock was moved back by
   * exactly `GAP_MS` at `agedAtMs`, so the gap the app sees cannot be less than
   * that, and cannot exceed it by more than the wall clock the harness spent
   * getting from the ageing to this read.
   */
  const harnessDelayMs = row.offerReadAtMs - row.agedAtMs!;
  expect(
    row.offer.elapsedMs,
    `${row.scenario}: the offer reports ${row.offer.elapsedMs}ms unaccounted for against a gap ` +
      `the harness set to exactly ${GAP_MS}ms. It cannot be smaller.`,
  ).toBeGreaterThanOrEqual(GAP_MS);
  expect(
    row.offer.elapsedMs! - GAP_MS,
    `${row.scenario}: the offer reports ${row.offer.elapsedMs}ms unaccounted for, which is ` +
      `${row.offer.elapsedMs! - GAP_MS}ms more than the ${GAP_MS}ms gap — larger than the ` +
      `${harnessDelayMs}ms the harness itself spent between setting the clock and reading the ` +
      "offer, so the app is inventing time",
  ).toBeLessThanOrEqual(harnessDelayMs);

  /**
   * The projection itself, recomputed by the harness from the offer's own three
   * inputs and required to match. This is the arithmetic the user is asked to
   * trust: position + elapsed x rate, clamped to the book.
   */
  expect(
    row.projectionErrorMs,
    `${row.scenario}: the offer projects ${row.offer.projectedMs}ms, but ${row.offer.recordedMs}ms ` +
      `+ ${row.offer.elapsedMs}ms x ${row.offer.playbackRate} clamped to a ${row.durationMs}ms ` +
      `book is ${row.recomputedProjectionMs}ms`,
  ).toBeLessThanOrEqual(1);
  expect(
    row.offer.projectedMs,
    `${row.scenario}: the projection ran past the end of a ${row.durationMs}ms book`,
  ).toBeLessThanOrEqual(row.durationMs);
  expect(
    row.offer.projectedMs,
    `${row.scenario}: the projection is not ahead of the saved position, so there is nothing to ` +
      "offer",
  ).toBeGreaterThan(recordedMs);
});

// ---------------------------------------------------------------------------
// R2 — the ordinary background, where nothing was lost
// ---------------------------------------------------------------------------

/**
 * The row that keeps the affordance from being a daily annoyance.
 *
 * Same backgrounding, same kill, same relaunch — with the app's writers left
 * alone. The cadence writes every 200 ms, so the last durable write is a
 * cadence writer and NOT the hide edge, which is precisely the condition the
 * detector requires. Nothing should be offered, and the row carries the
 * surviving `source` so the reason is in the ledger rather than inferred.
 *
 * A recovery prompt after an ordinary background is a bug the user meets
 * several times a day, so this is graded as hard as R1. Its fail-demo is
 * `HARK_RESUME_POISON=recovery-always-offers`, because running it against the
 * pre-change source proves nothing: a build with no affordance passes it
 * vacuously.
 */
test("R2: an ordinary background offers nothing, because nothing was lost", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R2 ordinary background, no recovery offered",
    bookIndex: 1,
  });
  recordRow(row);
  assertMeasured(row);

  expect(
    row.writersBlocked,
    `${row.scenario}: a writer was deleted on a row that is supposed to be measuring the ` +
      `ordinary build (${JSON.stringify(row.writersBlocked)})`,
  ).toStrictEqual([]);

  /**
   * THE HEADLINE, GRADED FIRST — and the order is deliberate rather than
   * stylistic. This row's fail-demo forges the signature into what the record
   * READS BACK as, which the harness's own witness necessarily shares: it goes
   * through the same `localStorage.getItem` the app does. With the corroborating
   * source check above this one, the poisoned run died on that instead and the
   * assertion the row exists for was never reached. MEASURED, and the reason
   * these two are in this order.
   */
  expect(
    row.offer.shown,
    `${row.scenario}: the app offered to move the user forward after an ORDINARY backgrounding, ` +
      `where the writers recorded the position all along (last write: ` +
      `"${row.recordAfterKill.source}", offering a jump to ${row.offer.projectedMs}ms from ` +
      `${row.offer.recordedMs}ms). This prompt would appear every time the user glanced at ` +
      "another app.",
  ).toBe(false);

  /**
   * WHY nothing was offered: the writers did their job, which is what makes
   * this the ordinary case rather than a suspended one. The hide-edge flush runs
   * and is then overwritten by the next cadence write ~200 ms later, so the
   * surviving record names a cadence writer — and the detector requires the
   * opposite. If it ever named the hide edge here, the cadence had stopped on a
   * foregrounded page, and that is a finding in its own right rather than a
   * reason to relax the row above.
   */
  expect(
    ["cadence-timer", "media-tick"],
    `${row.scenario}: after an ordinary backgrounding the last durable write was ` +
      `"${row.recordAfterKill.source}" rather than a cadence writer, so the 200ms cadence stopped ` +
      "on a page that was still playing",
  ).toContain(row.recordAfterKill.source);

  // And the position is still right, which is the thing the offer would have
  // been claiming to fix.
  expect(
    row.resumedAheadOfRecordMs,
    `${row.scenario}: the app resumed ${row.resumedAheadOfRecordMs}ms AHEAD of the position it ` +
      "saved",
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
});

// ---------------------------------------------------------------------------
// R3 — no means no, for that gap
// ---------------------------------------------------------------------------

/**
 * A dismissal is a promise about the NEXT launch.
 *
 * The offer is re-evaluated every time the book is opened, so an answer kept in
 * component state comes straight back the next time the user reaches for the
 * book — with the same estimate, about the same lost stretch, forever. This row
 * dismisses it, leaves the player, opens the book again and looks.
 *
 * It also grades what the dismissal must NOT do: the position may not move. "No
 * thanks" is not a seek.
 */
test("R3: a dismissed estimate stays dismissed for that gap", async () => {
  test.setTimeout(300_000);
  const row = await measureSuspensionRecovery({
    scenario: "R3 suspended session, offer dismissed",
    bookIndex: 2,
    killCadenceWriters: true,
    gapMs: GAP_MS,
    dismissAndReopen: true,
  });
  recordRow(row);
  assertMeasured(row);
  assertSuspensionSignature(row);

  const recordedMs = row.recordAfterKill.positionMs!;

  expect(
    row.offer.shown,
    `${row.scenario}: no offer appeared, so there was nothing to dismiss`,
  ).toBe(true);

  /**
   * NON-VACUITY, asserted before the dismissal is graded. The signature has to
   * survive the round trip through the library: if anything had overwritten the
   * hide-edge record between the two opens, the offer would be absent whether or
   * not the dismissal was remembered, and this row's green would mean nothing.
   *
   * It does survive, and for a reason worth naming: a book that is opened and
   * closed with no play, no seek and no rate change writes NOTHING
   * (`positionChangedRef` in `use-progress-persistence.ts`), which is the same
   * rule that keeps smart rewind from walking the position backwards on every
   * open. If that ever changes, this assertion fails rather than the row going
   * quietly vacuous.
   */
  expect(
    row.recordAtReopen!.source,
    `${row.scenario}: the durable record was rewritten between the dismissal and the second open ` +
      `("${row.recordAfterKill.source}" -> "${row.recordAtReopen!.source}"), so the signature was ` +
      "gone and an absent offer proves nothing about the dismissal",
  ).toBe("visibility-flush");
  expect(
    row.recordAtReopen!.writtenAt,
    `${row.scenario}: the hide-edge write's clock changed between the two opens, so the second ` +
      "open was looking at a different gap from the one that was dismissed",
  ).toBe(row.agedWrittenAt);

  expect(
    row.offerAfterDismissal!.shown,
    `${row.scenario}: the dismissed estimate came back on the next open of the same book, about ` +
      `the same ${GAP_MS}ms gap. The user has to say no to it every single time they reach for ` +
      "this book.",
  ).toBe(false);

  /** Dismissing is an answer, not a transport action. */
  expect(
    Math.abs(row.positionAfterDismissal! - recordedMs),
    `${row.scenario}: dismissing the estimate moved the position from ${recordedMs}ms to ` +
      `${row.positionAfterDismissal}ms. Declining an offer must not move the user.`,
  ).toBeLessThanOrEqual(CALLBACK_BAR_MS);
  expect(
    row.positionAfterDismissal! - recordedMs,
    `${row.scenario}: dismissing the estimate moved the user FORWARD to ` +
      `${row.positionAfterDismissal}ms`,
  ).toBeLessThanOrEqual(AHEAD_BAR_MS);
});
