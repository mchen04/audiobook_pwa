import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

/**
 * One sign-in budget, shared by every suite that drives this app server.
 *
 * `src/server/auth.ts` rate-limits `/sign-in/email` to 8 per 60s, and the
 * limiter lives in the SERVER — in memory, so `db:test:reset` does not clear it
 * and it does not care which Playwright project spent the attempts.
 *
 * THE WINDOW IS NOT ROLLING, and assuming it was is what made the first version
 * of this file fail. better-auth keeps a count and a `lastRequest` per key and
 * resets the count only when a request arrives more than `window` seconds after
 * the previous one:
 *
 *     if (now - lastRequest > window) count = 1; else count += 1;
 *     if (count > max) reject;
 *
 * So the counter resets on a full IDLE GAP, never on elapsed time alone. A
 * harness that merely spaces sign-ins out — five per rolling minute, say — keeps
 * the server permanently inside one window and the count climbs until it trips.
 * That is exactly what happened: parity spent seven (including a 44s pause,
 * comfortably under the 60s the reset actually needs), sync asked for three
 * more, and the tenth was refused. The failure surfaced in a sync spec as a bare
 * `waitForURL` timeout, which reads as a product bug and was not one.
 *
 * This models the server's rule instead of approximating it: count spends, and
 * when the next one would pass SAFE_MAX, sleep until a full window has elapsed
 * since the LAST attempt, which is the only thing that makes the server forget.
 *
 * The state is kept ON DISK because Playwright starts a fresh worker after a
 * failing test and consecutive runs share one app process, while an in-memory
 * counter would forget both and the server would not.
 */

const WINDOW_MS = 60_000;

/**
 * Six, against the server's eight. The headroom absorbs a retry and any sign-in
 * that reaches the server without passing through here — of which there should
 * be none, but the cost of being wrong is a confusing red suite.
 */
const SAFE_MAX = 6;

const STATE = path.join(tmpdir(), "hark-signins.json");

type Budget = { count: number; lastAt: number };

function read(): Budget {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE, "utf8"));
    if (parsed && typeof parsed === "object") {
      const { count, lastAt } = parsed as Partial<Budget>;
      if (typeof count === "number" && typeof lastAt === "number") return { count, lastAt };
    }
  } catch {
    // No state yet, or an older shape: start clean.
  }
  return { count: 0, lastAt: 0 };
}

function write(budget: Budget): void {
  try {
    writeFileSync(STATE, JSON.stringify(budget), "utf8");
  } catch {
    // Losing the state only costs a throttled attempt, which callers surface.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Marks the window as spent, so the next attempt waits a full one out. */
export function burnSignInWindow(): void {
  write({ count: SAFE_MAX, lastAt: Date.now() });
}

/**
 * Blocks until spending one sign-in is safe, then records it. `label` only
 * names the waiting suite in the log line.
 */
export async function awaitSignInBudget(label: string): Promise<void> {
  let budget = read();
  const idleFor = Date.now() - budget.lastAt;

  // The server has already forgotten: a full window passed with no attempt.
  if (idleFor > WINDOW_MS) budget = { count: 0, lastAt: 0 };

  if (budget.count >= SAFE_MAX) {
    // Only an idle gap clears the server's counter, so wait out the remainder
    // of one measured from the LAST attempt — not from when this window began.
    const waitMs = WINDOW_MS - (Date.now() - budget.lastAt) + 1_500;
    console.log(
      `[${label}] pausing ${Math.ceil(waitMs / 1000)}s for an idle window; the sign-in limiter ` +
        `only resets after ${WINDOW_MS / 1000}s with no attempt`,
    );
    await sleep(waitMs);
    budget = { count: 0, lastAt: 0 };
  }

  const next = { count: budget.count + 1, lastAt: Date.now() };
  write(next);
  console.log(`[${label}] sign-in ${next.count}/${SAFE_MAX} in this window`);
}
