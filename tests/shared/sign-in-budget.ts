import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

/**
 * One sign-in budget, shared by every suite that drives this app server.
 *
 * `src/server/auth.ts` rate-limits sign-in per window, and the limiter lives in
 * the SERVER — so it does not care which Playwright project spent the attempts.
 * The parity suite has always paced itself against this, deliberately spending
 * only part of the allowance and leaving "headroom for the other suites that
 * share this server". The other suites never claimed that headroom, they simply
 * assumed it: sync signed in whenever it liked, and passed only because it
 * usually ran when parity had not just finished.
 *
 * Running the full gate list back to back is what exposed it — parity spends its
 * five, sync immediately asks for more, and `outbox-durability` fails on a
 * 60-second `waitForURL` that reads exactly like a product bug and is not one.
 *
 * So the budget moved here and both harnesses now go through it. The window is
 * kept ON DISK rather than in memory, because Playwright starts a fresh worker
 * after a failing test and consecutive runs share one app process, while an
 * in-memory counter would forget both and the server would not.
 */

const WINDOW_MS = 60_000;

/**
 * Five, against the limiter's eight. The remaining three are headroom for a
 * retry and for anything signing in outside this helper.
 */
const BUDGET = 5;

const LOG = path.join(tmpdir(), "hark-signins.json");

function read(): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LOG, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "number") : [];
  } catch {
    return [];
  }
}

function write(times: number[]): void {
  try {
    writeFileSync(LOG, JSON.stringify(times), "utf8");
  } catch {
    // Losing the log only costs a throttled attempt, which the callers retry.
  }
}

/** Marks the window as spent, so the next attempt waits a full one out. */
export function burnSignInWindow(): void {
  const now = Date.now();
  write(Array.from({ length: BUDGET }, () => now));
}

/**
 * Blocks until spending one sign-in stays inside the window, then records it.
 * `label` only names the waiting suite in the log line.
 */
export async function awaitSignInBudget(label: string): Promise<void> {
  for (;;) {
    const now = Date.now();
    const times = read().filter((at) => now - at <= WINDOW_MS);
    if (times.length < BUDGET) {
      write([...times, now]);
      return;
    }
    const waitMs = WINDOW_MS - (now - times[0]!) + 750;
    console.log(`[${label}] pausing ${Math.ceil(waitMs / 1000)}s to stay inside the sign-in limit`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
