import {
  chromium,
  devices,
  expect,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { awaitSignInBudget } from "../../shared/sign-in-budget";
import { testAccountPassword } from "../../shared/test-account-password";
// Reused, not re-implemented: the sync suite owns the local-database connection
// and the account reset; the parity suite owns the network that can actually be
// unplugged (see the long note in `tests/parity/harness/network.ts` for why
// `context.setOffline` and `context.route` are both unusable here).
import { closeSql, resetAccount, sql } from "../../sync/harness/app";
import { startControllableNetwork, type ControllableNetwork } from "../../parity/harness/network";

/**
 * The resume oracle.
 *
 * One question, in the engine of record (WebKit / iPhone 15): when the app goes
 * away at a known instant, does it come back at that instant?
 *
 *   drift = | true position at termination - position after relaunch |
 *
 * The "true position" is never a number the app produced. It is sampled off the
 * `<audio>` element from the driving process microseconds before the
 * termination is issued and carried across the gap by the wall clock.
 *
 * TWO SURFACES ARE GRADED, not one. The user's complaint is "the resume
 * position is behind" — which they can see on the shelf without ever pressing
 * play. A suite that only reads the player's `currentTime` can report a clean
 * pass while the library card shows a stale number on every launch. So every
 * row also carries what the SHELF says, read through a different path (the
 * card's own progressbar and the mirror record it renders from) than the
 * player's `currentTime`, and both are graded against the same bar.
 *
 * Nothing here asserts on `src/`. It measures and records rows with enough
 * evidence to tell a real pass from an instrument that measured nothing; the
 * spec applies the bars.
 */

// ---------------------------------------------------------------------------
// Bars. Frozen: a fix loop may make these stricter, never looser.
// ---------------------------------------------------------------------------

/** A lifecycle callback WAS delivered (T1, T2, T4, T5). */
export const CALLBACK_BAR_MS = 250;
/** No callback was delivered at all (T3: SIGKILL). */
export const HARD_KILL_BAR_MS = 1_000;
/**
 * Resuming AHEAD of where the user was silently skips content, so it is a
 * blocker at any magnitude. This allowance is the instrument's own noise (the
 * evaluate round trip used to sample the true position), not a tolerance for
 * the product skipping content.
 */
export const AHEAD_BAR_MS = 250;

/**
 * How close to the end of a book counts as "finished" for the purposes of
 * spotting fixture exhaustion. Mirrors the app's own `BOOK_END_EPSILON_MS`
 * (1000 ms) with margin, because the app restarts a finished book from zero and
 * a cumulative row that lands there measures nothing.
 */
const BOOK_END_EPSILON_FOR_FIXTURE_MS = 2_000;

export const APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

/**
 * The engine the rows were measured in. WebKit is the engine of record and the
 * default; the knob exists only so a WebKit-specific result can be checked
 * against a second engine.
 *
 * How the app gets taken away, and why it is not `launchPersistentContext`:
 *
 * A WebKit persistent context under Playwright 1.61.1 cannot host this app at
 * all. Measured: the page reports `navigator.serviceWorker.getRegistrations()`
 * length 0 and `controller === null` for as long as you care to poll, while the
 * worker is demonstrably running (it creates and fills `chapterline-shell-v6`
 * on disk). The page and the worker are in two different storage sessions, so
 * every `cache.put` the page makes is accepted and never readable. Nothing in
 * this repo has ever run Cache Storage in a WebKit persistent context —
 * `tests/perf` uses one but its `selectEngine()` demands CDP CPU throttling,
 * which WebKit refuses, so it always falls through to Chromium.
 *
 * What DOES work in WebKit is what `tests/parity/harness/app.ts` does: an
 * EPHEMERAL `browser.newContext(...)`. That context is treated here as the
 * phone's disk. "The app was killed" is then a SIGKILL of the browser's
 * renderer process (`WebKit.WebContent`), which is precisely what iOS does to a
 * backgrounded PWA — the app's process dies and the device's storage does not.
 *
 * Measured across that kill: cookies, localStorage, IndexedDB and the
 * service-worker registration all survive. Those are every witness the resume
 * position lives in, so the thing under measurement crosses the gap on its own.
 * Cache Storage RECORDS do not survive, which is a Playwright/WebKit artifact
 * and not something an iPhone does; they hold the audiobook BYTES, which are
 * not under measurement. So the oracle snapshots Cache Storage before the kill
 * and puts it back after the relaunch (`snapshotCaches`/`restoreCaches`), and
 * verifies the restore rather than assuming it.
 */
export type Engine = "webkit" | "chromium";
export const ENGINE: Engine = process.env.HARK_RESUME_ENGINE === "chromium" ? "chromium" : "webkit";
const browserType = (): BrowserType => (ENGINE === "chromium" ? chromium : webkit);

/**
 * The build under test. No PASS is worth anything without it: a green row from
 * a stale `.next` is a row about a build nobody is shipping.
 */
export const BUILD_ID: string = (() => {
  const file = path.join(process.cwd(), ".next/BUILD_ID");
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "unknown";
  } catch {
    return "unknown";
  }
})();

const EMAIL = "resume-verifier@hark.test";
const PASSWORD = testAccountPassword("resume-verifier");

/**
 * Copies of the fixture's MPEG frames, so the book is long enough to measure
 * against. Three copies is ~24 s: long enough that an 8.5 s listen sits well
 * clear of both ends of the book (nothing trips the "stored at the very end
 * restarts from zero" rule) and short enough that one percent of the progress
 * bar — the finest thing the shelf can render — is ~240 ms.
 */
const FIXTURE_REPEAT = 3;
const FIXTURE = path.join(process.cwd(), "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
/**
 * The fixture's ID3v2 frames declare their byte lengths, so a title of exactly
 * this length can be swapped in without rewriting frame headers — the same
 * trick `tests/parity/harness/library-seed.ts` uses. The file NAME does not set
 * the title; the tag does, which is why every scenario book is named to fit.
 */
const FIXTURE_TITLE = "iPhone Downloads Test";

/** The 21-character book title scenario `index` owns. */
export function bookTitleFor(index: number): string {
  const title = `Resume Oracle Book ${String(index + 1).padStart(2, "0")}`;
  expect(title.length, `scenario title "${title}" does not fit the fixture's ID3 frame`).toBe(
    FIXTURE_TITLE.length,
  );
  return title;
}

export type NetworkMode = "online" | "offline";
export type Termination =
  | "hidden"
  | "pagehide"
  | "hard-kill"
  | "reload"
  | "in-app-nav"
  /**
   * Leave the player, THEN lose the process — the composed shape that replaces
   * the bare `in-app-nav` row.
   *
   * Leaving the player does not stop playback ON PURPOSE on this build
   * (548623c / f787e8e keep one library UI with the player alive while the user
   * browses), so `in-app-nav` alone terminates nothing and a resume bar applied
   * to it grades a session that never ended. This one keeps the deliberate
   * product behaviour and then applies a termination the build really does
   * treat as one, so the user journey "I hit back, then iOS killed the tab" is
   * covered instead of being reported as an untestable cell.
   */
  | "nav-then-hard-kill"
  /** The same journey, but the platform does deliver a callback first. */
  | "nav-then-pagehide";

export type ShelfReading = {
  /** `aria-valuenow` on the card's progressbar: integer percent. */
  percent: number | null;
  /** The card's own status text, e.g. "2 min • 8%". */
  statusText: string | null;
  /** The continue-listening card, when the book is the one it points at. */
  continueText: string | null;
  /** Percent turned back into milliseconds. Quantised by `quantumMs`. */
  impliedMs: number | null;
  /** Half of one percent of the book: the finest the rendered bar can be. */
  quantumMs: number;
  /**
   * Full-resolution value the card is rendered FROM — the mirror's playback
   * state, read straight out of IndexedDB. Independent of the audio element,
   * so the player and the shelf can be seen to disagree.
   */
  sourceMs: number | null;
  /** Third witness: this device's own local position key. */
  localMs: number | null;
  /** Whether the shelf was read before the player was opened on this relaunch. */
  readBeforePlayer: boolean;
};

export type Row = {
  scenario: string;
  /** No PASS is worth reading without the build and engine it was measured in. */
  engine: Engine;
  buildId: string;
  termination: Termination;
  network: NetworkMode;
  /** Liveness: how far the position advanced under this measurement. */
  playedMs: number;
  /** Liveness: `timeupdate` events the page actually fired while playing. */
  ticks: number;
  startedAtMs: number;
  truePositionMs: number;
  resumedPositionMs: number;
  /** Second witness on the player itself: the scrubber the user is looking at. */
  resumedUiMs: number | null;
  shelf: ShelfReading;
  behindMs: number;
  aheadMs: number;
  expectedRewindMs: number;
  driftMs: number;
  shelfDriftMs: number | null;
  barMs: number;
  /** Lifecycle events the page saw before it died. Empty is the T3 claim. */
  lifecycle: string[];
  /**
   * For the `hidden` termination: how the hidden state was produced. Anything
   * but `real` means this row does not cover the iOS background path, however
   * green its drift is.
   */
  hiddenTransition: HiddenTransition;
  /** What the page's OWN handler read from `document.visibilityState`. */
  visibilityAtCallback: string | null;
  /**
   * Lifecycle registrations the harness DROPPED before the app could make them
   * (see `LIFECYCLE_BLOCK_SCRIPT`). Empty on every ordinary row. A backstop row
   * whose list is empty measured an app with all its handlers intact and proves
   * nothing about the no-callback world.
   */
  lifecycleBlocked: string[];
  settleMs: number;
  settleTrail: number[];
  playbackRateBefore: number;
  playbackRateAfter: number;
  titleAfter: string;
  bookTitle: string;
  chapterAfter: string | null;
  expectedChapter: string | null;
  completedAfter: boolean | null;
  serverPositionMs: number | null;
  /**
   * True when the termination did not actually end the listening session (the
   * audio element survived it and was still playing). Such a row measures
   * continuity, not restoration, and the spec refuses to grade it as resume.
   */
  sessionSurvived: boolean;
  notes: string[];
};

export type CumulativeRow = {
  scenario: string;
  engine: Engine;
  buildId: string;
  network: NetworkMode;
  cycles: number;
  ticks: number;
  playedMs: number;
  /** Position after the listening cycle: the ground the later cycles must hold. */
  anchorMs: number;
  /** Player position after each no-listening open/close cycle. */
  positions: number[];
  /** Shelf source position after each cycle, same order. */
  shelfPositions: Array<number | null>;
  /** `positions[i-1] - positions[i]`: positive means the cycle lost ground. */
  perCycleDeltaMs: number[];
  /** `anchor - positions[last]`: the number that actually matters. */
  totalDriftMs: number;
  shelfTotalDriftMs: number | null;
  barMs: number;
  rewindObserved: number[];
  /** Simulated absence applied before each cycle; null when the cycles ran back to back. */
  absenceBetweenCyclesMs: number | null;
  notes: string[];
};

/** One book's absence must not move a different book. */
export type CrossBookRow = {
  scenario: string;
  engine: Engine;
  buildId: string;
  absenceMs: number;
  /** The book that was paused and left alone. */
  absentBookTitle: string;
  /** The book that must not move. */
  otherBookTitle: string;
  otherStoredMs: number;
  otherResumedMs: number;
  /** Positive means the untouched book was rewound by another book's absence. */
  leakedRewindMs: number;
  /** The rewind the ladder would have applied had the absence been this book's. */
  rewindIfLeakedMs: number;
  markerKeysSeen: string[];
  ticks: number;
  playedMs: number;
  notes: string[];
};

// ---------------------------------------------------------------------------
// A long, real MP3, built from the committed fixture
// ---------------------------------------------------------------------------

/**
 * The committed fixture is eight seconds long — shorter than the app's own
 * five-second local-save interval, so a book that short cannot show drift, only
 * the end of the book. This repeats its MPEG frames and patches the Xing
 * frame/byte counts so every decoder (and `music-metadata`, which the import
 * path uses) reports the real, longer duration.
 */
export function buildLongMp3(repeat = FIXTURE_REPEAT, tailPadding = 0, title?: string): Buffer {
  const original = readFileSync(FIXTURE);
  const source = title
    ? Buffer.from(original.toString("latin1").replace(FIXTURE_TITLE, title), "latin1")
    : original;
  const id3Size = (source[6]! << 21) | (source[7]! << 14) | (source[8]! << 7) | source[9]!;
  const audioStart = 10 + id3Size;
  let audioEnd = source.length;
  if (source.subarray(audioEnd - 128, audioEnd - 125).toString("latin1") === "TAG") audioEnd -= 128;

  const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const header = source.readUInt32BE(audioStart);
  const sampleRate = [44100, 48000, 32000][(header >> 10) & 3]!;
  const bitrate = bitrates[(header >> 12) & 15]! * 1000;
  const xingLength = Math.floor((144 * bitrate) / sampleRate) + ((header >> 9) & 1);

  const tags = Buffer.from(source.subarray(0, audioStart));
  const xing = Buffer.from(source.subarray(audioStart, audioStart + xingLength));
  const body = Buffer.from(source.subarray(audioStart + xingLength, audioEnd));

  const marker = xing.indexOf("Xing", 0, "latin1");
  expect(marker, "the fixture no longer carries a Xing header").toBeGreaterThan(0);
  const flags = xing.readUInt32BE(marker + 4);
  let cursor = marker + 8;
  if (flags & 1) {
    xing.writeUInt32BE(xing.readUInt32BE(cursor) * repeat, cursor);
    cursor += 4;
  }
  if (flags & 2) xing.writeUInt32BE(xing.readUInt32BE(cursor) * repeat, cursor);

  return Buffer.concat([
    tags,
    xing,
    ...Array.from({ length: repeat }, () => body),
    // A distinct tail is a distinct sha256, so each scenario's book registers
    // separately instead of the server answering 409 and merging them.
    Buffer.alloc(tailPadding),
  ]);
}

// ---------------------------------------------------------------------------
// Instrumentation injected into the page (test-only; `src/` is untouched)
// ---------------------------------------------------------------------------

const LIFECYCLE_KEY = "resume-oracle:lifecycle";
const PROBE_SCRIPT = `
(() => {
  const state = { ticks: 0, lastPositionMs: 0, hiddenObserved: false, visibilityAtCallback: null };
  window.__resumeProbe = state;
  window.addEventListener("timeupdate", (event) => {
    const media = event.target;
    if (!media || typeof media.currentTime !== "number") return;
    state.ticks += 1;
    state.lastPositionMs = media.currentTime * 1000;
  }, true);
  const note = (name) => {
    try {
      const seen = JSON.parse(localStorage.getItem(${JSON.stringify(LIFECYCLE_KEY)}) || "[]");
      seen.push(name + "@" + Date.now());
      localStorage.setItem(${JSON.stringify(LIFECYCLE_KEY)}, JSON.stringify(seen));
    } catch {}
  };
  window.addEventListener("pagehide", () => note("pagehide"));
  window.addEventListener("beforeunload", () => note("beforeunload"));
  window.addEventListener("unload", () => note("unload"));
  window.addEventListener("freeze", () => note("freeze"));
  // The state the PAGE saw at the instant its own handler ran, not what the
  // driving process believes it arranged. A build that gates its flush on
  // \`document.visibilityState === "hidden"\` is only exercised when this reads
  // "hidden", so the row has to carry the observation rather than assume it.
  document.addEventListener("visibilitychange", () => {
    note("visibilitychange");
    state.visibilityAtCallback = document.visibilityState;
    if (document.visibilityState === "hidden") state.hiddenObserved = true;
  });
})();
`;

/**
 * The seeded faults for the fail-demo, kept OUTSIDE the code under test.
 *
 * `drop-local-position` makes writes to the per-book local position key a
 * no-op, which is what a regression in the save path looks like from outside.
 * `stale-shelf` rewinds every mirror playback-state write by 30 s, which is
 * what "the shelf shows a stale number" looks like from outside while the
 * player itself may still be right.
 *
 * Both are enabled only by `HARK_RESUME_POISON`; unset, this adds nothing.
 */
function poisonScript(): string | null {
  const poison = process.env.HARK_RESUME_POISON;
  if (!poison) return null;
  if (poison === "drop-local-position") {
    return `
      (() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (typeof key === "string" && key.startsWith("chapterline:position:")) return;
          return setItem.call(this, key, value);
        };
      })();
    `;
  }
  if (poison === "seek-back-400ms") {
    // The third fault, added because the first two turned out not to
    // DISCRIMINATE on this build: the app resumes from the server value, so
    // suppressing the local key changes the row's `localMs` witness and nothing
    // else, and rewinding a mirror write cannot be seen when the app makes no
    // mirror write. A fail-demo that cannot flip a passing cell has not
    // demonstrated anything.
    //
    // This one is aimed at what the bars are actually about: it makes every
    // restore land 400 ms early — 150 ms past the 250 ms callback bar, far
    // below the five-second save interval, and invisible to every other suite
    // in this repo. Only a seek that RESTORES is touched (the first assignment
    // on a fresh element); ordinary playback and user scrubs are left alone, so
    // a poisoned run still plays for real and still produces live rows.
    return `
      (() => {
        const media = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "currentTime",
        );
        if (!media || !media.set) return;
        const restored = new WeakSet();
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          ...media,
          set(value) {
            let next = value;
            if (!restored.has(this) && typeof value === "number" && value > 1000 / 1000) {
              restored.add(this);
              next = Math.max(0, value - 0.4);
            }
            return media.set.call(this, next);
          },
        });
      })();
    `;
  }
  if (poison === "stale-shelf") {
    return `
      (() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === "playbackStates" && value && typeof value.positionMs === "number") {
            value = { ...value, positionMs: Math.max(0, value.positionMs - 30000) };
          }
          return key === undefined ? put.call(this, value) : put.call(this, value, key);
        };
      })();
    `;
  }
  if (poison === "persist-rewound-start") {
    // The fail-demo for the CUMULATIVE rows, arrived at after two others were
    // measured and rejected for not discriminating. Both rejections are
    // recorded because each one is a fact about this build:
    //
    //  - `seek-back-400ms` on C3: `positions [7404 x5]`,
    //    `perCycleDeltaMs [0,0,0,0,0]` — a clean PASS. It shifts every restore
    //    by the SAME amount, and a constant offset is not a WALK; the
    //    cumulative columns grade movement BETWEEN cycles, so it cancels.
    //  - shrinking the stored localStorage record on read: `positions
    //    [7815 x5]` — also a clean PASS. The shelf moved (12815 -> 12415) and
    //    the PLAYER did not, because with the local record's `occurredAt` left
    //    alone the server's value still won `freshestPosition`. Poisoning a
    //    record the restore does not prefer proves nothing.
    //
    // This one reproduces the actual pre-fix defect instead of approximating
    // it: on close, the (already rewound) start position is written back as if
    // the user had chosen it, with a FRESH `occurredAt` so it wins the merge —
    // which is what makes it compound. Each cycle then rewinds from the
    // previous cycle's rewound value: one full rewind tier lost per open.
    //
    // The book is taken from the URL (`/books/:id`), so exactly one record is
    // touched and never the wrong book's.
    return `
      (() => {
        addEventListener("pagehide", () => {
          const audio = document.querySelector("audio");
          const match = /\\/books\\/([0-9a-fA-F-]{36})/.exec(location.pathname);
          if (!audio || !match) return;
          const suffix = ":" + match[1];
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith("chapterline:position:") || !key.endsWith(suffix)) continue;
            localStorage.setItem(
              key,
              JSON.stringify({
                positionMs: Math.round(audio.currentTime * 1000),
                occurredAt: Date.now(),
              }),
            );
            return;
          }
        });
      })();
    `;
  }
  throw new Error(`unknown HARK_RESUME_POISON value: ${process.env.HARK_RESUME_POISON}`);
}

/**
 * Kills every lifecycle callback the app can subscribe to, so what is left is
 * the 200 ms cadence and nothing else.
 *
 * WHY THIS EXISTS. T1 asks "does the app survive being backgrounded?" and this
 * instrument cannot answer it: Playwright/WebKit exposes no way to make a page
 * genuinely report `visibilityState === "hidden"` (measured — no
 * `setActivityState` in `playwright-core`, and a second page plus
 * `bringToFront` leaves the first at `"visible"`), so `assertHiddenIsReal`
 * records that cell as an engine GAP and it stays one.
 *
 * But the user-facing question underneath T1 is not "does the handler fire?".
 * It is "if the handler never fires at all, how much do I lose?" — and THAT is
 * answerable here, because the answer does not depend on the platform
 * delivering anything. Deleting every handler and measuring what the cadence
 * alone preserves bounds the residual from above: on a real iPhone the callback
 * either arrives (in which case the drift is the one T1 already measures with
 * the handler alive) or it does not (in which case it is this one). Neither
 * branch is unmeasured.
 *
 * WHAT IT DOES NOT COVER, and must never be read as covering: iOS may also
 * freeze the timer when it freezes the page. This bounds "no callback"; it does
 * not bound "no callback and no timer". That cell stays UNCOVERED.
 *
 * HOW IT STAYS HONEST. It patches `EventTarget.prototype.addEventListener`, so
 * it drops registrations made AFTER it runs. The oracle's own probe registers
 * in `PROBE_SCRIPT`, which is added to the context first and therefore runs
 * first — so the journal still records that the platform DELIVERED the
 * callback, while the app never sees it. Every dropped type is pushed onto
 * `window.__lifecycleBlocked`, which every row carries: a run where the app
 * registered nothing would mean the poison bit nothing, and a green from it
 * would be vacuous.
 */
const LIFECYCLE_BLOCK_SCRIPT = `
(() => {
  const doomed = new Set(["visibilitychange", "pagehide", "beforeunload", "unload", "freeze"]);
  const blocked = [];
  window.__lifecycleBlocked = blocked;
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof type === "string" && doomed.has(type)) {
      blocked.push(type);
      return undefined;
    }
    return original.call(this, type, listener, options);
  };
})();
`;

// ---------------------------------------------------------------------------
// Account, network, golden profile
// ---------------------------------------------------------------------------

export type Fixture = {
  userId: string;
  origin: string;
  net: ControllableNetwork;
  books: Map<string, { id: string; title: string }>;
  durationMs: number;
  chapters: Array<{ title: string; startMs: number; endMs: number }>;
};

let fixture: Fixture | null = null;

/**
 * The device. One ephemeral context for the whole run, because it is the thing
 * that has to survive every kill — it is standing in for the phone's disk.
 */
type Device = { browser: Browser; context: BrowserContext };
let device: Device | null = null;

/**
 * Renderer processes that were already running when this run started. They
 * belong to somebody else and are never killed. (Another session on this
 * machine periodically runs `pkill -f playwright`; the courtesy is returned.)
 */
let foreignRenderPids = new Set<string>();

/**
 * A same-origin document Playwright serves itself, so a JS context on the app's
 * origin can be obtained with the network physically cut — which is what the
 * offline rows need in order to put the audiobook bytes back before the app is
 * allowed to look for them.
 */
const RESTORE_PATH = "/__resume-oracle-restore__";
const RESTORE_TITLE = "resume-oracle-restore";

/**
 * Recognises THIS engine's renderer process in `ps` output.
 *
 * Scoped to the exact browser BUILD this run drives, because more than one
 * Playwright browser build is usually installed on a developer machine and
 * killing another run's renderer would be both rude and untraceable. WebKit's
 * `executablePath()` is `<build>/pw_run.sh`, and its renderer is the
 * `com.apple.WebKit.WebContent` XPC service inside that same build directory.
 */
function isRenderProcess(line: string): boolean {
  const executable = browserType().executablePath();
  if (ENGINE === "webkit") {
    return line.includes(`${path.dirname(executable)}/com.apple.WebKit.WebContent`);
  }
  return line.includes(executable) && line.includes("--type=renderer");
}

function renderPids(): string[] {
  try {
    return execFileSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter(isRenderProcess)
      .map((line) => line.trim().split(/\s+/)[0]!)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function openDevice(): Promise<Device> {
  if (device) return device;
  foreignRenderPids = new Set(renderPids());
  const browser = await browserType().launch();
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    serviceWorkers: "allow",
  });
  await context.addInitScript({ content: PROBE_SCRIPT });
  const poison = poisonScript();
  if (poison) await context.addInitScript({ content: poison });
  // Narrow on purpose: the app never requests this path, so the interception
  // cannot answer anything the offline proof depends on.
  await context.route(`**${RESTORE_PATH}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>${RESTORE_TITLE}</title>`,
    }),
  );
  device = { browser, context };
  return device;
}

type Session = { page: Page };

/**
 * Whether each page's renderer has died.
 *
 * Asked via the `crash` event rather than by probing the page, because an
 * `evaluate` sent to a SIGKILLed renderer never answers and never rejects — it
 * hangs until the test's own timeout, which turns "the kill worked" into a
 * five-minute red with no row.
 */
const crashed = new WeakMap<Page, { yes: boolean }>();

function trackCrash(page: Page): Page {
  const state = { yes: false };
  crashed.set(page, state);
  page.on("crash", () => {
    state.yes = true;
  });
  return page;
}

/** A fresh page on the device. Not a fresh device: that is the whole point. */
async function launch(): Promise<Session> {
  const { context } = await openDevice();
  return { page: trackCrash(await context.newPage()) };
}

/**
 * How the T1 "hidden" termination was actually produced.
 *
 * `real` — the platform genuinely reported this page as hidden.
 * `synthesised-state` — it did not, so `document.visibilityState`/`hidden` were
 *   overridden on the page and the event dispatched. The app's handler observes
 *   exactly what it would observe on a real backgrounding, which is strictly
 *   more faithful than dispatching the event alone; but it is still the driving
 *   process asserting the state rather than the platform reporting it, so a row
 *   produced this way does NOT cover the real iOS background path.
 */
export type HiddenTransition = "real" | "synthesised-state" | "not-applicable";

const REAL_HIDDEN_TIMEOUT_MS = 3_000;

/**
 * Put the page in the background — for real if this engine can, and honestly
 * labelled when it cannot.
 *
 * MEASURED, Playwright 1.61.1 / WebKit: opening a second page in the same
 * context and calling `bringToFront()` leaves the first page's
 * `document.visibilityState` at `"visible"` and fires no `visibilitychange` at
 * all. Playwright's WebKit backend exposes no activity-state control either —
 * there is no `Page.setActivityState` anywhere in `playwright-core` — so there
 * is no way from here to make WebKit report a page as hidden. The attempt is
 * made anyway, every run, rather than assumed to fail: if a future Playwright
 * or engine gains the capability this starts returning `real` on its own, and
 * the spec's UNCOVERED gate stops firing without anyone having to notice.
 */
async function background(page: Page): Promise<HiddenTransition> {
  const { context } = await openDevice();
  const cover = await context.newPage();
  await cover.bringToFront().catch(() => undefined);
  const wentHidden = await page
    .waitForFunction(() => document.visibilityState === "hidden", undefined, {
      timeout: REAL_HIDDEN_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);
  // Kept open on purpose when it worked: closing it would bring the measured
  // page back to the foreground before the kill.
  if (wentHidden) return "real";
  await cover.close().catch(() => undefined);

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  return "synthesised-state";
}

/** What the page's own `visibilitychange` handler saw, read from the live page. */
async function readVisibilityWitness(
  page: Page,
): Promise<{ hiddenObserved: boolean; visibilityAtCallback: string | null }> {
  return page
    .evaluate(() => {
      const probe = (
        window as unknown as {
          __resumeProbe?: { hiddenObserved?: boolean; visibilityAtCallback?: string | null };
        }
      ).__resumeProbe;
      return {
        hiddenObserved: !!probe?.hiddenObserved,
        visibilityAtCallback: probe?.visibilityAtCallback ?? null,
      };
    })
    .catch(() => ({ hiddenObserved: false, visibilityAtCallback: null }));
}

// ---------------------------------------------------------------------------
// Carrying the audiobook bytes across a process death
// ---------------------------------------------------------------------------

type CacheEntry = {
  url: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
};
export type CacheSnapshot = Array<{ name: string; entries: CacheEntry[] }>;

async function snapshotCaches(page: Page): Promise<CacheSnapshot> {
  const snapshot = (await page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const entries = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        entries.push({
          url: request.url,
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()] as Array<[string, string]>,
          body: btoa(binary),
        });
      }
      out.push({ name, entries });
    }
    return out;
  })) as CacheSnapshot;
  const media = snapshot.flatMap((cache) =>
    cache.entries.filter((entry) => entry.url.includes("/offline-media/")),
  );
  expect(
    media.length,
    "nothing in Cache Storage looks like this device's copy of an audiobook, so there would be " +
      "nothing to put back after the kill and the relaunch would be measuring a device that " +
      "never had the book",
  ).toBeGreaterThan(0);
  return snapshot;
}

/**
 * Puts the bytes back, and PROVES it.
 *
 * `caches.delete(name)` first is load-bearing: after a renderer death the cache
 * NAME list survives while every existing cache is a dead handle whose `put()`
 * silently no-ops. Measured — write into the stale name: `{"keys":0}`; delete
 * and recreate the same name: `{"keys":1}`. Without the delete, the restore
 * reports twenty-two entries written and the app comes up with an empty device.
 */
async function restoreCaches(page: Page, snapshot: CacheSnapshot): Promise<void> {
  const counts = await page.evaluate(async (input: CacheSnapshot) => {
    const written: Record<string, number> = {};
    for (const { name, entries } of input) {
      await caches.delete(name);
      const cache = await caches.open(name);
      for (const entry of entries) {
        const binary = atob(entry.body);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1)
          bytes[index] = binary.charCodeAt(index);
        await cache.put(
          new Request(entry.url),
          new Response(bytes, {
            status: entry.status,
            statusText: entry.statusText || undefined,
            headers: entry.headers,
          }),
        );
      }
      // Counted by READING BACK, never by counting the puts that were issued.
      written[name] = (await (await caches.open(name)).keys()).length;
    }
    return written;
  }, snapshot);
  const expected = Object.fromEntries(snapshot.map((cache) => [cache.name, cache.entries.length]));
  expect(
    counts,
    "Cache Storage did not come back after the relaunch, so the device does not have the " +
      "audiobook and every position read below would be measuring a book that is not there",
  ).toStrictEqual(expected);
}

async function signIn(page: Page, origin: string, register: boolean): Promise<void> {
  await awaitSignInBudget("resume");
  await page.goto(`${origin}/${register ? "register" : "login"}`, {
    waitUntil: "domcontentloaded",
  });
  if (register) {
    await page.getByLabel("Name").fill("Resume Verifier");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel(/Password/).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.waitForURL(/\/library/, { timeout: 90_000 }).catch(async (error: unknown) => {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    if (body.includes("Too many requests")) {
      throw new Error(
        "better-auth rate-limited the resume verifier's sign-in. That is the harness overspending " +
          "the shared window in tests/shared/sign-in-budget.ts, not a product failure.",
      );
    }
    throw error;
  });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
}

/**
 * Can this engine, in this profile, do the two things the measurement depends
 * on — run the service worker, and hand back bytes it was told to cache?
 *
 * Checked ONCE, before a single book is imported, because both failures are
 * silent. A dead Cache Storage does not throw; the import "succeeds", the card
 * appears, and the book is simply not on the device — which then presents
 * ninety seconds later as "the player never came up", a sentence that sounds
 * like a product defect and is not one. Measure the instrument first.
 */
async function assertEngineCanStoreMedia(page: Page): Promise<void> {
  const state = await page
    .evaluate(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const registration = await navigator.serviceWorker?.getRegistration("/");
        const value = registration?.active?.state ?? registration?.installing?.state ?? "none";
        if (value === "activated") return "activated";
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return "none";
    })
    .catch(() => "unavailable");
  const cache = await page.evaluate(async () => {
    try {
      const probe = await caches.open("resume-oracle-probe");
      await probe.put("/resume-oracle/probe", new Response(new Uint8Array(1024)));
      const back = await probe.match("/resume-oracle/probe");
      await caches.delete("resume-oracle-probe");
      return back ? "round-trips" : "put-but-no-match";
    } catch (error) {
      return `threw: ${String(error).slice(0, 120)}`;
    }
  });
  expect(
    `${state}/${cache}`,
    `${ENGINE} cannot host this app's media: service worker "${state}", Cache Storage ` +
      `"${cache}". Hark keeps audiobook bytes in Cache Storage, so on this engine every book ` +
      'imports as "Not on this device" and no position can be measured. This is the ' +
      "INSTRUMENT failing, not the product — an ephemeral WebKit context passes this probe, so " +
      "if it is failing the launch path has been changed back to something that cannot host the " +
      "app. Fix the harness; do not record product rows from a run that got here.",
  ).toBe("activated/round-trips");
}

/**
 * One signed-in device with the books already imported, built once and shared
 * by every scenario.
 *
 * Every scenario needs a warm device (service worker, Cache Storage, mirror,
 * cookies) and its own book, and rebuilding that per scenario would spend the
 * whole budget on sign-ins the rate limiter would then start refusing.
 */
export async function resumeFixture(count: number): Promise<Fixture> {
  const titles = Array.from({ length: count }, (_, index) => bookTitleFor(index));
  if (fixture) return fixture;

  const net = await startControllableNetwork(APP_ORIGIN);
  const { page } = await launch();
  try {
    const existing = await sql()<{ id: string }[]>`
      SELECT id FROM "user" WHERE lower(email) = ${EMAIL.toLowerCase()}
    `;
    await signIn(page, net.origin, existing.length === 0);
    const [row] = await sql()<{ id: string }[]>`
      SELECT id FROM "user" WHERE lower(email) = ${EMAIL.toLowerCase()}
    `;
    const userId = row!.id;
    await resetAccount(userId);
    await page.goto(`${net.origin}/library`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
    await assertEngineCanStoreMedia(page);
    // The worker has to be CONTROLLING, not merely activated: an uncontrolled
    // page cannot be served `/offline-media/*`, which is the URL the player
    // plays from. Every suite in this repo that opens a player does this
    // (`tests/parity/harness/app.ts` `warmUp`); the oracle skipped it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 60_000,
    });
    await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });

    for (const [index, title] of titles.entries()) {
      await page.setInputFiles('input[aria-label="Choose an MP3 file to import"]', {
        name: `${title}.mp3`,
        mimeType: "audio/mpeg",
        buffer: buildLongMp3(FIXTURE_REPEAT, 64 + index * 16, title),
      });
      await expect(
        page.getByRole("link", { name: title, exact: true }).first(),
        `book "${title}" never finished importing`,
      ).toBeVisible({ timeout: 120_000 });
      // The card appearing is NOT the import succeeding. It renders from the
      // mirror row, which lands BEFORE the audio is written to this device, and
      // when that write fails the card simply keeps wearing "Not on this
      // device" — while the player it links to can never mount. So poll the
      // card until the audio is actually here, and fail as an instrument if it
      // never arrives. (Polled, not read once: read-once turned the normal
      // ordering of the import into a spurious red.)
      const readOnDevice = () =>
        page.evaluate((bookTitle) => {
          const card = [...document.querySelectorAll("article.book-item")].find(
            (node) => (node.querySelector(".book-title")?.textContent ?? "").trim() === bookTitle,
          );
          if (!card) return "no card";
          return card.querySelector(".book-device-missing") ? "not on this device" : "on device";
        }, title);
      await expect
        .poll(readOnDevice, {
          timeout: 120_000,
          message:
            `book "${title}" imported but its audio never reached this device. The library shows ` +
            "the card and the player it links to cannot mount, so nothing below would be " +
            "measuring resume.",
        })
        .toBe("on device");
    }

    // The import is local-first: the card appears from this device's own mirror
    // before the outbox has delivered the registration, so the server view has
    // to be waited for rather than read once.
    const readBooks = async () =>
      sql()<{ id: string; title: string; duration_ms: number }[]>`
        SELECT b.id, b.title, m.duration_ms
        FROM books b JOIN media_assets m ON m.book_id = b.id
        WHERE b.owner_id = ${userId}
      `;
    await expect
      .poll(async () => (await readBooks()).length, {
        timeout: 120_000,
        message: "not every imported book reached the server",
      })
      .toBeGreaterThanOrEqual(titles.length);
    const rows = await readBooks();
    const idByTitle = new Map(rows.map((entry) => [entry.title, entry.id]));
    const books = new Map<string, { id: string; title: string }>();
    for (const title of titles) {
      const id = idByTitle.get(title);
      expect(id, `book "${title}" never reached the server`).toBeTruthy();
      books.set(title, { id: id!, title });
    }
    const durationMs = Number(rows[0]!.duration_ms);
    expect(
      durationMs,
      "the generated book is too short to measure drift against a five-second save interval",
    ).toBeGreaterThan(20_000);
    const chapterRows = await sql()<{ title: string; start_ms: number; end_ms: number }[]>`
      SELECT c.title, c.start_ms, c.end_ms FROM chapters c
      WHERE c.book_id = ${books.get(titles[0]!)!.id} ORDER BY c.position
    `;

    fixture = {
      userId,
      origin: net.origin,
      net,
      books,
      durationMs,
      chapters: chapterRows.map((entry) => ({
        title: entry.title,
        startMs: Number(entry.start_ms),
        endMs: Number(entry.end_ms),
      })),
    };
    return fixture;
  } finally {
    // The PAGE, not the device: the device is the disk everything below depends
    // on surviving.
    await page.close().catch(() => undefined);
  }
}

export async function closeResumeFixture(): Promise<void> {
  if (fixture) {
    await fixture.net.close();
    fixture = null;
  }
  if (device) {
    await device.browser.close().catch(() => undefined);
    device = null;
  }
  await closeSql();
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * Kills the app the way a phone kills a backgrounded one: SIGKILL to the
 * renderer process, nothing gets to run. `page.close()` and `context.close()`
 * are graceful shutdowns and DO deliver `pagehide`, which would quietly turn T3
 * into a second copy of T2 — the `lifecycle` column on every row is what keeps
 * that honest.
 *
 * The device (cookies, localStorage, IndexedDB, the worker registration) lives
 * outside this process and survives, which is exactly what happens on iOS.
 */
/**
 * Set the moment a renderer is killed, cleared the moment the bytes are put
 * back. A device left in the killed state has a dead Cache Storage, and the
 * NEXT scenario would open onto a phone that has lost its audiobook — which
 * presents as "the player never became ready", a product-shaped sentence for a
 * harness-shaped fact. Measured: C2 died exactly this way, with no row, after
 * C1's last cycle ended on a kill.
 */
let deviceMediaBroken = false;

/**
 * Wall-clock instant the SIGKILL was actually issued, in the driving process.
 *
 * The true position is a sample carried forward across an interval, so which
 * instant the interval ENDS at is part of the measurement, not bookkeeping.
 * `hardKill` shells out to `/bin/ps -Ao pid=,command=` to find the renderer,
 * and on a loaded machine that scan is not free — MEASURED, during a full
 * 19-row pass: a row extrapolated to the moment the kill was REQUESTED read
 * 900 ms AHEAD of where the app came back, because the audio went on playing,
 * and the 200 ms cadence went on writing, for the whole length of that scan.
 * The same row standalone read 16 ms.
 *
 * "Resumed ahead" is the most serious verdict this suite has, and it was being
 * manufactured by the instrument's own latency. So the extrapolation ends where
 * the process really died: here, one statement before the signal.
 */
let lastKillAtMs = 0;

function hardKill(): string[] {
  const pids = renderPids().filter((pid) => !foreignRenderPids.has(pid));
  expect(
    pids.length,
    `no ${ENGINE} renderer process started by this run was found, so nothing was hard-killed and ` +
      "the measurement below would be grading a graceful shutdown",
  ).toBeGreaterThan(0);
  lastKillAtMs = Date.now();
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone; the assertion above is what guards the measurement.
    }
  }
  deviceMediaBroken = true;
  return pids;
}

/**
 * Leaves the device the way a phone is left: with the book still on it. Called
 * from every measurement's `finally`, including the ones that threw.
 */
async function healDevice(origin: string, media: CacheSnapshot | null): Promise<void> {
  if (!deviceMediaBroken || !media) return;
  const healed = await relaunch(origin, media).catch((error: unknown) => {
    console.log(`[resume-oracle] could not restore the device after a kill: ${String(error)}`);
    return null;
  });
  await healed?.page.close().catch(() => undefined);
}

/**
 * The kill has to have landed on the process that was hosting the measurement.
 * A SIGKILL sent to some other renderer, with this page still answering, would
 * turn every row after it into a reload wearing a crash's name.
 */
async function expectPageDead(page: Page, killed: string[]): Promise<void> {
  await expect
    .poll(() => crashed.get(page)?.yes ?? false, {
      timeout: 20_000,
      message:
        `SIGKILL was sent to ${killed.join(",") || "(nothing)"} but the page hosting the ` +
        "measurement never reported its renderer dying, so this row is not the termination it " +
        "claims to be",
    })
    .toBe(true);
}

/**
 * Comes back after the kill: a new page on the same device, with the audiobook
 * bytes put back before the app is allowed to look for them.
 *
 * The restore happens on a Playwright-served stub document, so it works with
 * the network physically cut — an offline row never touches the network to get
 * its device back.
 */
async function relaunch(
  origin: string,
  media: CacheSnapshot,
): Promise<Session & { carried: string[] }> {
  const { context } = await openDevice();
  // A page whose renderer was SIGKILLed is left alone. Closing one wedges the
  // context: the next `newPage()` never resolves, which presents as a bare test
  // timeout with no row — measured twice before this comment existed.
  for (const open of context.pages()) {
    if (crashed.get(open)?.yes || open.isClosed()) continue;
    await Promise.race([
      open.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  const page = trackCrash(await context.newPage());
  await page.goto(`${origin}${RESTORE_PATH}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  expect(
    await page.title(),
    "the restore document did not come up, so the audiobook could not be put back",
  ).toBe(RESTORE_TITLE);
  await restoreCaches(page, media);
  deviceMediaBroken = false;
  // Read the lifecycle journal HERE, before anything navigates.
  //
  // The journal is one localStorage key shared by every page on this origin,
  // and the restore document carries the probe too — so navigating away from it
  // writes its own `beforeunload`/`pagehide`/`unload` into the very list that
  // decides whether T3 saw no callback. Measured: the first WebKit row came
  // back claiming five lifecycle events for a scenario that dispatched one.
  // Take the surviving evidence first, then clear, so nothing the HARNESS does
  // from here on can be read as something the app did.
  const carried = await readLifecycle(page);
  await page.evaluate((key) => localStorage.removeItem(key), LIFECYCLE_KEY);
  return { page, carried };
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

/**
 * Opens a book the way a user does: through the library.
 *
 * A direct `goto("/books/:id")` looked equivalent and was not. This app is
 * local-first — the audio lives in this device's media store, and the library
 * shell is what runs the launch sweep that attaches it. Navigating straight to
 * the player skipped that sweep, so every scenario landed on "the audio for
 * this book is stored on your devices ... this device does not currently have
 * it", the transport never mounted, and the suite died before producing a
 * single measurement. Every passing suite in this repo (parity, sync) reaches
 * a book by clicking its card, and so does a real user.
 */
async function openPlayer(
  page: Page,
  origin: string,
  bookId: string,
  title?: string,
): Promise<void> {
  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
  if (title) {
    await page.getByRole("link", { name: title, exact: true }).first().click();
  } else {
    await page.goto(`${origin}/books/${bookId}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
  }
  await settlePlayer(page);
}

/** The player's "Library" control, whichever of its two elements is rendered. */
function playerBackControl(page: Page) {
  return page
    .getByRole("link", { name: /^Library$/ })
    .or(page.getByRole("button", { name: /^Library$/ }))
    .first();
}

async function settlePlayer(page: Page): Promise<void> {
  // `data-launch-ready` is rendered by the LIBRARY shell only
  // (`library-client.tsx`); it never appears on `/books/:id`. Waiting for it
  // here made every measurement die in the harness before a single row was
  // produced. The player route's own readiness signal is the transport
  // control, asserted just below, so that is what we wait on.
  //
  // A bare timeout would say "the player never came up", which is a product
  // claim. Read the page before making it.
  await page
    .getByRole("button", { name: /^(Play|Pause)$/ })
    .waitFor({ state: "visible", timeout: 90_000 })
    .catch(async (error: unknown) => {
      const url = page.url();
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "(unreadable)");
      throw new Error(
        `the player never became ready at ${url}. Page said: ${body.slice(0, 400)}\n` +
          `(original: ${String(error).slice(0, 200)})`,
      );
    });
  await expect(
    page.getByRole("button", { name: /^(Play|Pause)$/ }),
    "the player never came up, so no position could be read",
  ).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const audio = document.querySelector("audio");
      return !!audio && !!audio.currentSrc;
    },
    undefined,
    { timeout: 90_000 },
  );
}

/**
 * What the shelf shows, read WITHOUT touching the player.
 *
 * Three witnesses, deliberately not derived from each other: the rendered
 * progressbar (what the user's eye gets, quantised to whole percent), the
 * mirror record the card is rendered from (full resolution), and this device's
 * own local position key. A row where they disagree is the interesting row.
 */
async function readShelf(
  page: Page,
  origin: string,
  bookId: string,
  title: string,
  userId: string,
  durationMs: number,
): Promise<ShelfReading> {
  await page.goto(`${origin}/library`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
  await expect(
    page.getByRole("link", { name: title, exact: true }).first(),
    "the book never appeared on the shelf, so its displayed progress could not be read",
  ).toBeVisible({ timeout: 90_000 });

  const rendered = await page.evaluate(
    ([bookTitle, continueLabel]) => {
      const cards = [...document.querySelectorAll("article.book-item")];
      const card = cards.find(
        (node) => (node.querySelector(".book-title")?.textContent ?? "").trim() === bookTitle,
      );
      const bar = card?.querySelector('[role="progressbar"]');
      const status = card?.querySelector(".book-progress-status");
      const continueCard = document.querySelector(`[aria-label="${continueLabel}"]`);
      return {
        percent: bar ? Number(bar.getAttribute("aria-valuenow")) : null,
        statusText: status ? (status.textContent ?? "").trim() : null,
        continueText: continueCard ? (continueCard.textContent ?? "").trim() : null,
      };
    },
    [title, `Continue listening ${title}`] as const,
  );

  const sourceMs = await page.evaluate(
    ([id, user]) =>
      new Promise<number | null>((resolve) => {
        const request = indexedDB.open("chapterline-offline-v1");
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("playbackStates")) return resolve(null);
          const all = db.transaction("playbackStates").objectStore("playbackStates").getAll();
          all.onerror = () => resolve(null);
          all.onsuccess = () => {
            const match = (all.result as Array<Record<string, unknown>>).find(
              (row) => row.bookId === id && (row.userId === undefined || row.userId === user),
            );
            resolve(match && typeof match.positionMs === "number" ? match.positionMs : null);
          };
        };
      }),
    [bookId, userId] as const,
  );

  const localMs = await page.evaluate(
    ([user, id]) => {
      const raw = localStorage.getItem(`chapterline:position:${user}:${id}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { positionMs?: number } | number;
        return typeof parsed === "number" ? parsed : (parsed.positionMs ?? null);
      } catch {
        return Number(raw) || null;
      }
    },
    [userId, bookId] as const,
  );

  return {
    percent: rendered.percent,
    statusText: rendered.statusText,
    continueText: rendered.continueText,
    impliedMs: rendered.percent === null ? null : (rendered.percent / 100) * durationMs,
    quantumMs: Math.round(durationMs / 200),
    sourceMs,
    localMs,
    readBeforePlayer: true,
  };
}

/**
 * The position the app came back at.
 *
 * Sampled until two consecutive reads agree, because a player that seeks after
 * metadata loads would otherwise be graded on whichever half of that race the
 * test happened to catch. The trail stays in the row: a value that only settles
 * after seconds is evidence in its own right.
 */
async function readSettledPosition(
  page: Page,
): Promise<{ positionMs: number; settleMs: number; trail: number[] }> {
  const started = Date.now();
  const trail: number[] = [];
  let previous: number | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await page.evaluate(() => {
      const audio = document.querySelector("audio");
      return audio ? audio.currentTime * 1000 : -1;
    });
    trail.push(Math.round(value));
    if (previous !== null && Math.abs(value - previous) < 1 && value >= 0) {
      return { positionMs: value, settleMs: Date.now() - started, trail };
    }
    previous = value;
    await page.waitForTimeout(150);
  }
  return { positionMs: previous ?? -1, settleMs: Date.now() - started, trail };
}

async function readUiPosition(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Audiobook position"]',
    );
    return input ? Number(input.value) : null;
  });
}

/**
 * Union of what the live page reported before it died and what survived to the
 * relaunch. Union, not replacement: the pre-kill read is the stronger evidence
 * (it came from memory), and the post-relaunch read can still contain callbacks
 * delivered after the last read. Neither may be allowed to erase the other.
 */
function mergeLifecycle(before: string[], after: string[]): string[] {
  return [...new Set([...before, ...after])];
}

/** The page's own timestamp for the last teardown callback it ran, if any. */
function lastUnloadAt(lifecycle: string[]): number | null {
  const stamps = lifecycle
    .filter((entry) => /^(unload|pagehide)@/.test(entry))
    .map((entry) => Number(entry.split("@")[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return stamps.length ? Math.max(...stamps) : null;
}

async function readLifecycle(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || "[]") as string[];
    } catch {
      return [];
    }
  }, LIFECYCLE_KEY);
}

/** The audio element's own position, in milliseconds. -1 when there is none. */
async function readAudioPositionMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const audio = document.querySelector("audio");
    return audio ? audio.currentTime * 1000 : -1;
  });
}

/** One unsent progress row as it sits in the outbox. */
export type QueuedProgressRow = {
  positionMs: number | null;
  eventOccurredAt: string | null;
  completed: boolean | null;
  deviceId: string | null;
  deviceSequence: number | null;
};

/**
 * What the outbox is holding for one book, read straight out of
 * `chapterline-sync-v1`.
 *
 * `indexedDB.databases()` is asked FIRST rather than opening blind: a bare
 * `indexedDB.open(name)` CREATES an empty version-1 database when the name does
 * not exist yet, and the app would then run its v1→v5 upgrade against a
 * database this test invented. Reading must not be able to change what is being
 * read.
 */
async function readQueuedProgress(
  page: Page,
  userId: string,
  bookId: string,
): Promise<QueuedProgressRow[]> {
  return page.evaluate(
    ([user, book]) =>
      new Promise<QueuedProgressRow[]>((resolve) => {
        void (async () => {
          const names = (await indexedDB.databases?.().catch(() => [])) ?? [];
          if (!names.some((entry) => entry.name === "chapterline-sync-v1")) return resolve([]);
          const request = indexedDB.open("chapterline-sync-v1");
          request.onerror = () => resolve([]);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("mutations")) return resolve([]);
            const all = db.transaction("mutations").objectStore("mutations").getAll();
            all.onerror = () => resolve([]);
            all.onsuccess = () => {
              const rows = (all.result as Array<Record<string, never>>)
                .filter(
                  (row) =>
                    (row as { userId?: string }).userId === user &&
                    (row as { kind?: string }).kind === "progress" &&
                    (row as { entityId?: string }).entityId === book,
                )
                .map((row) => {
                  const payload = ((row as { payload?: Record<string, unknown> }).payload ??
                    {}) as Record<string, unknown>;
                  return {
                    positionMs: typeof payload.positionMs === "number" ? payload.positionMs : null,
                    eventOccurredAt:
                      typeof payload.eventOccurredAt === "string" ? payload.eventOccurredAt : null,
                    completed: typeof payload.completed === "boolean" ? payload.completed : null,
                    deviceId: (row as { deviceId?: string }).deviceId ?? null,
                    deviceSequence: (row as { deviceSequence?: number }).deviceSequence ?? null,
                  };
                });
              resolve(rows);
            };
          };
        })();
      }),
    [userId, bookId] as const,
  );
}

/** This device's durable local record for one book, exactly as written. */
export type LocalRecord = {
  positionMs: number | null;
  occurredAt: number | null;
  completed: boolean | null;
  playbackRate: number | null;
};

async function readLocalRecord(page: Page, userId: string, bookId: string): Promise<LocalRecord> {
  return page.evaluate(
    ([user, book]) => {
      const empty = {
        positionMs: null,
        occurredAt: null,
        completed: null,
        playbackRate: null,
      };
      try {
        const raw = localStorage.getItem(`chapterline:position:${user}:${book}`);
        if (!raw) return empty;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
          positionMs: typeof parsed.positionMs === "number" ? parsed.positionMs : null,
          occurredAt: typeof parsed.occurredAt === "number" ? parsed.occurredAt : null,
          completed: typeof parsed.completed === "boolean" ? parsed.completed : null,
          playbackRate: typeof parsed.playbackRate === "number" ? parsed.playbackRate : null,
        };
      } catch {
        return empty;
      }
    },
    [userId, bookId] as const,
  );
}

/** The mirror's own completion flag for one book — the shelf's witness. */
async function readMirrorCompleted(
  page: Page,
  userId: string,
  bookId: string,
): Promise<boolean | null> {
  return page.evaluate(
    ([user, book]) =>
      new Promise<boolean | null>((resolve) => {
        const request = indexedDB.open("chapterline-offline-v1");
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("playbackStates")) return resolve(null);
          const all = db.transaction("playbackStates").objectStore("playbackStates").getAll();
          all.onerror = () => resolve(null);
          all.onsuccess = () => {
            const match = (all.result as Array<Record<string, unknown>>).find(
              (row) => row.bookId === book && (row.userId === undefined || row.userId === user),
            );
            resolve(match && typeof match.completed === "boolean" ? match.completed : null);
          };
        };
      }),
    [userId, bookId] as const,
  );
}

/**
 * Puts one book back to "never opened", everywhere this device or the server
 * could remember it.
 *
 * This is ISOLATION, not a relaxed fixture: `measure()` already deletes the
 * server row for the same reason. The rows share three ~24 s books and each one
 * starts wherever the last left off, so a scenario that needs sixteen seconds
 * of headroom has to be given a book at zero or it silently measures the end of
 * the fixture instead of the thing it is named after. Every witness is cleared
 * together — server row, this device's durable local record, the mirror the
 * shelf renders from, the pause marker the rewind ladder reads, and any unsent
 * outbox row — because leaving one behind is how a "reset" book comes back
 * carrying a position from two scenarios ago.
 */
async function resetBookEverywhere(page: Page, userId: string, bookId: string): Promise<void> {
  await sql()`DELETE FROM playback_states WHERE book_id = ${bookId}`;
  await page.evaluate(
    ([user, book]) =>
      new Promise<void>((resolve) => {
        void (async () => {
          try {
            localStorage.removeItem(`chapterline:position:${user}:${book}`);
            localStorage.removeItem(`chapterline:last-paused-at:${user}:${book}`);
          } catch {
            /* storage blocked; the stores below are still worth clearing */
          }
          const names = (await indexedDB.databases?.().catch(() => [])) ?? [];
          const clear = (dbName: string, store: string, matches: (row: unknown) => boolean) =>
            new Promise<void>((done) => {
              if (!names.some((entry) => entry.name === dbName)) return done();
              const request = indexedDB.open(dbName);
              request.onerror = () => done();
              request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(store)) return done();
                const transaction = db.transaction(store, "readwrite");
                const cursorRequest = transaction.objectStore(store).openCursor();
                cursorRequest.onerror = () => done();
                cursorRequest.onsuccess = () => {
                  const cursor = cursorRequest.result;
                  if (!cursor) return;
                  if (matches(cursor.value)) cursor.delete();
                  cursor.continue();
                };
                transaction.oncomplete = () => done();
                transaction.onerror = () => done();
                transaction.onabort = () => done();
              };
            });
          await clear("chapterline-offline-v1", "playbackStates", (row) => {
            const entry = row as { bookId?: string; userId?: string };
            return entry.bookId === book && (entry.userId === undefined || entry.userId === user);
          });
          await clear("chapterline-sync-v1", "mutations", (row) => {
            const entry = row as { userId?: string; kind?: string; entityId?: string };
            return entry.userId === user && entry.kind === "progress" && entry.entityId === book;
          });
          resolve();
        })();
      }),
    [userId, bookId] as const,
  );
}

/** Postgres' view of one book's progress. The row the server would serve. */
async function readServerProgress(
  bookId: string,
): Promise<{ positionMs: number; completed: boolean } | null> {
  const [row] = await sql()<{ position_ms: number; completed: boolean }[]>`
    SELECT position_ms, completed FROM playback_states WHERE book_id = ${bookId}
  `;
  return row ? { positionMs: Number(row.position_ms), completed: row.completed } : null;
}

/**
 * `rewindForAbsence` from `src/lib/playback-core.ts`, restated so the oracle
 * grades against the CONTRACT rather than against the implementation.
 *
 * It is a ONE-TIME, bounded allowance for a real absence. It is subtracted only
 * from a single terminate→relaunch measurement; the cumulative measurement
 * below never subtracts it, so a rewind that stacks across repeated opens shows
 * up as lost ground rather than being explained away.
 */
function expectedRewindMs(input: {
  smartRewind: boolean;
  msSinceLastPause: number | null;
}): number {
  if (!input.smartRewind || input.msSinceLastPause === null) return 0;
  const absence = input.msSinceLastPause;
  if (!Number.isFinite(absence) || absence < 60_000) return 0;
  if (absence < 10 * 60_000) return 5_000;
  if (absence < 60 * 60_000) return 15_000;
  return 30_000;
}

/**
 * The two inputs the app's own smart rewind reads, read the same way the app
 * reads them, so `expectedRewindMs` models the app instead of guessing at it.
 *
 * The pause marker is keyed by user AND book (`playback-core.ts:lastPausedKey`).
 * It was a single global key until the absence of book A was found to rewind
 * book B; this reader tracks the app's real key. If the app's key changes again
 * and this is not updated, the model silently reads `null` for every book and
 * every rewind row starts crediting 0 — so the shape of the key is asserted
 * against the app's, below, rather than trusted.
 */
async function readRewindInputs(
  page: Page,
  userId: string,
  bookId: string,
): Promise<{ smartRewind: boolean; msSinceLastPause: number | null; markerKeysSeen: string[] }> {
  return page.evaluate(
    ({ id, book }) => {
      let smartRewind = true;
      try {
        const raw = localStorage.getItem(`chapterline:preferences:${id}`);
        if (raw) {
          const parsed = JSON.parse(raw) as { preferences?: { smartRewind?: boolean } };
          if (typeof parsed?.preferences?.smartRewind === "boolean") {
            smartRewind = parsed.preferences.smartRewind;
          }
        }
      } catch {
        smartRewind = true;
      }
      // Every marker key the app actually wrote, so a key-shape drift between
      // the app and this reader shows up as a row that names the keys it found
      // instead of as a quietly-zero rewind model.
      const markerKeysSeen: string[] = [];
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key?.startsWith("chapterline:last-paused-at")) markerKeysSeen.push(key);
        }
      } catch {
        /* storage blocked; the empty list is the honest answer */
      }
      const marker = Number(localStorage.getItem(`chapterline:last-paused-at:${id}:${book}`) || 0);
      return {
        smartRewind,
        msSinceLastPause: marker > 0 ? Date.now() - marker : null,
        markerKeysSeen,
      };
    },
    { id: userId, book: bookId },
  );
}

/**
 * Fails loudly when the app writes pause markers this reader cannot address.
 * A reader that silently misses the marker turns every smart-rewind row into a
 * vacuous "expected 0, got 0".
 */
function assertMarkerKeyShape(scenario: string, userId: string, keys: string[]): void {
  const unaddressable = keys.filter(
    (key) => !key.startsWith(`chapterline:last-paused-at:${userId}:`),
  );
  expect(
    unaddressable,
    `${scenario}: the app wrote pause marker key(s) this oracle does not model ` +
      `(${JSON.stringify(unaddressable)}). readRewindInputs is reading ` +
      `"chapterline:last-paused-at:<userId>:<bookId>" and would report a rewind of 0 for a ` +
      "book the app is actually rewinding. Update the reader, not this assertion.",
  ).toStrictEqual([]);
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

export type ScenarioSpec = {
  /** Row label. */
  scenario: string;
  /**
   * Which of the fixture's books this row uses. WebKit's Cache Storage in a
   * fresh profile refuses to hold more than a few hundred kilobytes of media
   * (measured: three 98 KB books stored, the fourth failed with the app's
   * "could not save the audiobook for offline playback" alert), so the books
   * are shared and their progress is reset before each row instead.
   */
  bookIndex: number;
  termination: Termination;
  network: NetworkMode;
  /** Milliseconds of real playback before the app is taken away. */
  playMs?: number;
  /** Press "Back N seconds" just before termination (the skip-ahead trap). */
  rewindBeforeTermination?: boolean;
  /** Open the player from the library grid instead of by URL. */
  openFromLibrary?: boolean;
  /**
   * Delete every lifecycle callback the app could subscribe to on the session
   * that is about to be terminated, so the row measures what the 200 ms cadence
   * preserves ON ITS OWN. See `LIFECYCLE_BLOCK_SCRIPT`.
   */
  killLifecycleHandlers?: boolean;
  /**
   * Put the book back to "never opened" on every witness before the row runs.
   *
   * `measure()` clears the SERVER row for isolation but deliberately leaves this
   * device's local position alone — a row starting where the last one stopped is
   * also what a real phone does, and it is recorded as `startedAtMs`. That is
   * fine for a row that needs 8.5 s of a 24 s book and it is NOT fine for a row
   * that needs the position it ends at to be meaningful: in a full pass the
   * shared books are worn down and the row measures the end of the fixture.
   * Rows that need known headroom ask for it here.
   */
  resetBookFirst?: boolean;
};

const LEDGER =
  process.env.HARK_RESUME_LEDGER ?? path.join(tmpdir(), "hark-resume-oracle", "rows.jsonl");

export function recordRow(
  row: Row | CumulativeRow | CrossBookRow | StaleAheadRow | CompletionRow | TwoDeviceRow,
): void {
  mkdirSync(path.dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`, "utf8");
  console.log(`[resume-oracle] ${JSON.stringify(row)}`);
}

async function proveOffline(page: Page, origin: string): Promise<void> {
  const reached = await page.evaluate(async (target) => {
    try {
      await fetch(`${target}/api/sync/pull?control=1`, { cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }, origin);
  expect(
    reached,
    "the network was asked to go away but a control request still reached the server, so every " +
      "offline measurement below would be a lie",
  ).toBe(false);
}

/** Plays for real and refuses to continue if nothing actually played. */
/**
 * Pause the way the user does, so the APP writes its own absence marker.
 *
 * Nothing here may write the marker on the app's behalf: a marker the harness
 * invented would prove the harness can rewind a book, not that the app can.
 */
async function pauseThroughUi(page: Page): Promise<void> {
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.count()) {
    await pause.first().click();
  } else {
    // Some builds label the single transport control by its next action only.
    await page.evaluate(() => document.querySelector("audio")?.pause());
  }
  await expect
    .poll(() => page.evaluate(() => document.querySelector("audio")?.paused ?? false), {
      timeout: 10_000,
      message: "the player never paused, so the app never wrote an absence marker",
    })
    .toBe(true);
  await page.waitForTimeout(250);
}

/**
 * Move the app's own pause marker `absenceMs` into the past.
 *
 * This is a clock advance applied to the one value the absence is computed
 * from, and it is the only way to reach the upper rewind tiers (10 minutes,
 * 1 hour) inside a test. It refuses to CREATE a marker: returns null when the
 * app never wrote one, so the caller can fail instead of silently grading the
 * 0 ms tier. Returns the original timestamp it replaced.
 */
async function ageAbsenceMarker(
  page: Page,
  userId: string,
  bookId: string,
  absenceMs: number,
): Promise<number | null> {
  return page.evaluate(
    ({ id, book, absence }) => {
      const key = `chapterline:last-paused-at:${id}:${book}`;
      try {
        const existing = Number(localStorage.getItem(key) || 0);
        if (!(existing > 0)) return null;
        localStorage.setItem(key, String(Date.now() - absence));
        return existing;
      } catch {
        return null;
      }
    },
    { id: userId, book: bookId, absence: absenceMs },
  );
}

async function playForReal(page: Page, playMs: number): Promise<{ startedAtMs: number }> {
  const startedAtMs = await page.evaluate(() => {
    const audio = document.querySelector("audio");
    return audio ? audio.currentTime * 1000 : -1;
  });
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const audio = document.querySelector("audio");
          return audio ? audio.currentTime * 1000 : 0;
        }),
      {
        timeout: 30_000,
        message:
          "the audio never advanced in WebKit, so this run measured nothing. A zero-drift row " +
          "from a player that never played is not a pass.",
      },
    )
    .toBeGreaterThan(startedAtMs + 500);
  await page.waitForTimeout(playMs);
  return { startedAtMs };
}

/**
 * Runs one row of the matrix end to end. Applying the bars is the spec's job;
 * this only refuses to return a row it could not honestly measure.
 */
export async function measure(spec: ScenarioSpec): Promise<Row> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books, durationMs } = active!;
  const bookTitle = bookTitleFor(spec.bookIndex);
  const book = books.get(bookTitle);
  expect(book, `no book was imported for scenario "${spec.scenario}"`).toBeTruthy();
  const bookId = book!.id;
  // Isolation only: the row starts from a book with no progress anywhere, so
  // nothing another row wrote can be mistaken for what this one measured.
  await sql()`DELETE FROM playback_states WHERE book_id = ${bookId}`;

  const playMs = spec.playMs ?? 8_500;
  const notes: string[] = [];
  // The scenarios share ONE device and run serially — one phone, several books,
  // which is also what a user has. Isolation comes from resetting the book's
  // server progress above; whatever local position a previous row left behind
  // is simply where this row starts, and it is recorded as `startedAtMs`.

  net.restore();
  net.reset();

  let media: CacheSnapshot | null = null;
  let session = await launch();
  let killed = false;
  try {
    // Before the first navigation, so the app's own registrations are the ones
    // dropped and the probe's (added to the context, and therefore run first)
    // are not.
    if (spec.killLifecycleHandlers) {
      await session.page.addInitScript({ content: LIFECYCLE_BLOCK_SCRIPT });
    }
    if (spec.resetBookFirst) {
      await session.page.goto(`${origin}/library`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await session.page.waitForSelector("[data-launch-ready]", {
        state: "attached",
        timeout: 90_000,
      });
      await resetBookEverywhere(session.page, userId, bookId);
      notes.push("the book was reset on every witness before this row ran");
    }
    if (spec.openFromLibrary) {
      await session.page.goto(`${origin}/library`, { waitUntil: "domcontentloaded" });
      await session.page.waitForSelector("[data-launch-ready]", { state: "attached" });
      await session.page.getByRole("link", { name: bookTitle, exact: true }).click();
      await settlePlayer(session.page);
    } else {
      await openPlayer(session.page, origin, bookId, bookTitle);
    }
    await session.page.evaluate((key) => localStorage.removeItem(key), LIFECYCLE_KEY);

    // Taken now, while the network is still up and nothing is being timed: the
    // bytes do not change while the user listens, and a snapshot taken next to
    // the kill would sit inside the interval `truePositionMs` extrapolates
    // across.
    media = await snapshotCaches(session.page);

    // The network condition goes on BEFORE any listening, so everything the app
    // would do about this position happens under it.
    if (spec.network === "offline") {
      net.cut();
      await proveOffline(session.page, origin);
    }

    const { startedAtMs } = await playForReal(session.page, playMs);

    // Liveness is "how far did this run actually play", which is NOT the same
    // as "where did it end up". A scenario that deliberately presses Back 15
    // seconds ends up NEARER the start than it began, and reading the final
    // position as `playedMs` made the skip-ahead traps abort with "nothing
    // played" — the harness calling a real nine-second listen dead because the
    // user rewound. Sample the high-water mark, before any rewind.
    const advancedToMs = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      return audio ? audio.currentTime * 1000 : -1;
    });

    if (spec.rewindBeforeTermination) {
      await session.page.getByRole("button", { name: /^Back \d+ seconds$/ }).click();
      await session.page.waitForTimeout(500);
    }

    const rate = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      return audio?.playbackRate ?? 1;
    });

    // The true position: sampled off the element, timestamped on both sides,
    // then carried forward across the gap to the instant of termination.
    const sampledAt = Date.now();
    const sample = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return {
        positionMs: audio ? audio.currentTime * 1000 : -1,
        paused: audio?.paused ?? true,
        ticks: probe?.ticks ?? 0,
        // Read from the page that is about to die, so a backstop row carries
        // proof that the app really did try to register the handlers this run
        // took away from it.
        blocked: (window as unknown as { __lifecycleBlocked?: string[] }).__lifecycleBlocked ?? [],
        // The page's own clock, so a position can be carried forward to an
        // instant the PAGE timestamped (its unload) rather than to one this
        // process timestamped.
        pageNowMs: Date.now(),
      };
    });
    const sampleReturnedAt = Date.now();
    expect(
      sample.ticks,
      "the page fired no timeupdate events, so nothing was measured here",
    ).toBeGreaterThan(2);
    expect(
      sample.paused,
      "the audio was not playing at the moment of termination, so this row is not measuring a " +
        "user who was interrupted mid-listen",
    ).toBe(false);

    let truePositionMs: number;
    let lifecycle: string[] = [];
    let sessionSurvived = false;
    let hiddenTransition: HiddenTransition =
      spec.termination === "hidden" ? "synthesised-state" : "not-applicable";
    let visibilityAtCallback: string | null = null;

    if (spec.termination === "hidden" || spec.termination === "pagehide") {
      // The lifecycle callback the platform delivers, then the kill: exactly
      // what a backgrounded iOS PWA gets — one callback, then nothing.
      if (spec.termination === "hidden") {
        hiddenTransition = await background(session.page);
      } else {
        await session.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      }
      await session.page.waitForTimeout(300);
      const witness = await readVisibilityWitness(session.page);
      visibilityAtCallback = witness.visibilityAtCallback;
      if (spec.termination === "hidden" && !witness.hiddenObserved) {
        notes.push(
          'the page\'s own visibilitychange handler did not see visibilityState === "hidden", ' +
            "so this row did not exercise the backgrounded path at all",
        );
      }
      // Read the LIVE page. The probe journals callbacks into localStorage, and
      // localStorage is flushed to disk lazily — a SIGKILL a few hundred
      // milliseconds later routinely loses the last write. Measured: the first
      // row this oracle ever produced came back with `lifecycle: []` for a
      // pagehide the page had demonstrably handled. Reading before the kill is
      // what keeps "the callback fired" an observation rather than a coin flip.
      lifecycle = await readLifecycle(session.page);
      // Killed FIRST, then extrapolated to the instant the signal went out.
      // `hardKill` scans the process table to find the renderer, and the audio
      // plays on for the whole length of that scan — see `lastKillAtMs`.
      const killedPids = hardKill();
      truePositionMs = sample.positionMs + (lastKillAtMs - sampleReturnedAt) * rate;
      await expectPageDead(session.page, killedPids);
      killed = true;
    } else if (spec.termination === "hard-kill") {
      // Read the live page BEFORE the kill for the same reason as above: an
      // empty list has to mean "no callback was delivered", not "the evidence
      // did not survive". This read is what makes the 1000 ms bar's precondition
      // an observation rather than an assumption.
      lifecycle = await readLifecycle(session.page);
      const killedPids = hardKill();
      truePositionMs = sample.positionMs + (lastKillAtMs - sampledAt) * rate;
      await expectPageDead(session.page, killedPids);
      killed = true;
    } else if (
      spec.termination === "nav-then-hard-kill" ||
      spec.termination === "nav-then-pagehide"
    ) {
      // Step one: the user leaves the player. Playback deliberately continues.
      await playerBackControl(session.page).click();
      await session.page.waitForURL(/\/library/, { timeout: 60_000 });
      const stillPlaying = await session.page.evaluate(() => {
        const audio = document.querySelector("audio");
        return !!audio && !audio.paused;
      });
      notes.push(
        stillPlaying
          ? "left the player; playback continued, which is the product's deliberate behaviour"
          : "left the player and playback stopped — the composed termination is now redundant " +
              "with the plain in-app navigation, and the product behaviour recorded in 548623c / " +
              "f787e8e has changed",
      );
      // Step two: the real termination, applied from the library, where the
      // user actually is. The bar is the terminating step's bar, not the
      // navigation's.
      if (spec.termination === "nav-then-pagehide") {
        await session.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        await session.page.waitForTimeout(300);
        lifecycle = await readLifecycle(session.page);
        truePositionMs = sample.positionMs + (Date.now() - sampleReturnedAt) * rate;
      } else {
        lifecycle = await readLifecycle(session.page);
        truePositionMs = sample.positionMs + (Date.now() - sampledAt) * rate;
      }
      // Whether the audio is still running at the instant of the kill decides
      // whether the extrapolation above is honest, so it is asserted, not
      // assumed: an element that stopped somewhere in the navigation would make
      // `truePositionMs` overshoot and manufacture a "resumed behind" reading.
      const playingAtTermination = await session.page.evaluate(() => {
        const audio = document.querySelector("audio");
        return {
          present: !!audio,
          paused: audio?.paused ?? true,
          at: (audio?.currentTime ?? 0) * 1000,
        };
      });
      if (!playingAtTermination.present || playingAtTermination.paused) {
        // The element stopped. Its own last value is the honest true position —
        // BUT only while it still has one.
        //
        // MEASURED, full 19-row pass: leaving the player tore the element down
        // instead of leaving it playing (`currentSrc: ""`, `src` attribute gone),
        // which zeroes `currentTime`. Reading that zero as "where the user was"
        // gave T7 `truePositionMs: 0` against a resume of 18651 ms and reported
        // an 18-second drift for a build that had done nothing wrong. A torn-down
        // element is the ABSENCE of evidence, so it is treated as absent: the
        // fallback is the position sampled while the audio was demonstrably
        // playing, which is a lower bound, and the row says so.
        const tornDown =
          playingAtTermination.present && playingAtTermination.at < sample.positionMs - 1_000;
        truePositionMs =
          playingAtTermination.present && !tornDown ? playingAtTermination.at : sample.positionMs;
        notes.push(
          tornDown
            ? "the audio element was TORN DOWN by the navigation (its currentTime collapsed to " +
                `${Math.round(playingAtTermination.at)}ms from a sampled ` +
                `${Math.round(sample.positionMs)}ms), so its value is not evidence of anything. ` +
                "The true position here is the last position observed while it was demonstrably " +
                "playing, which is a LOWER bound: the element may have run on for up to the " +
                "length of the navigation before it was destroyed."
            : "the audio was not playing at the moment of termination, so the true position is " +
                "the element's own last value rather than an extrapolation",
        );
      }
      const killedPids = hardKill();
      await expectPageDead(session.page, killedPids);
      killed = true;
    } else if (spec.termination === "reload") {
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      // The audio keeps playing while the reload is being carried out, and the
      // app keeps saving as it does — so "the position at termination" is the
      // position when the OLD DOCUMENT DIED, not when the reload was asked for.
      // Extrapolating to the request instant made this row read 930 ms AHEAD on
      // a build whose own stored value (`shelf.localMs`) matched what it came
      // back at to the millisecond: a manufactured blocker on the most serious
      // assertion the oracle has. The page timestamps its own unload, so use
      // that. Later, never earlier, so a genuine skip still shows.
      const unloadAt = lastUnloadAt(await readLifecycle(session.page));
      truePositionMs =
        sample.positionMs + Math.max(0, (unloadAt ?? Date.now()) - sample.pageNowMs) * rate;
      if (unloadAt === null) {
        notes.push(
          "the reloaded page journaled no unload, so the true position was extrapolated to the " +
            "moment the reload finished instead",
        );
      }
    } else {
      truePositionMs = sample.positionMs + (Date.now() - sampledAt) * rate;
      // The player's own back control is a BUTTON when the library opens the
      // player in place (`onBack`) and a LINK on the `/books/:id` route, which
      // is the route a card click lands on — see `FullPlayer`'s topbar. Asking
      // only for the button made this scenario wait out its whole 300 s timeout
      // on a control that was on screen the entire time. Accept the control,
      // not one of its two spellings.
      await playerBackControl(session.page).click();
      // The in-app navigation IS the URL change; that is what this termination
      // mode is. Do not also require the library GRID here: this app renders
      // one library UI that can keep the player on screen at `/library` while a
      // session is live (measured — the page came back as `/library` with the
      // player region still mounted), and whether that is right is
      // `tests/parity/player-back.spec.ts`'s question, not this oracle's. What
      // it must never do is quietly pass, so it goes in the row as a note.
      await session.page.waitForURL(/\/library/, { timeout: 60_000 });
      const gridShown = await session.page
        .getByRole("heading", { name: "Library", exact: true })
        .isVisible()
        .catch(() => false);
      if (!gridShown) {
        notes.push("after the in-app navigation the library grid was not on screen");
      }
      // Did the navigation actually END the listening session? On this build it
      // does not: the audio element survives the in-app navigation and keeps
      // playing, so there is nothing to restore and "resumed 925 ms ahead" was
      // the oracle timing a session that never stopped. That is a COVERAGE
      // fact, recorded as one, not a product blocker.
      sessionSurvived = await session.page.evaluate(() => {
        const audio = document.querySelector("audio");
        return !!audio && !audio.paused;
      });
      if (sessionSurvived) {
        notes.push(
          "UNCOVERED: the in-app navigation did not end the listening session — the audio element " +
            "survived it and was still playing afterwards. Nothing was restored, so this row " +
            "measures continuity and says nothing about resume. A termination that this build " +
            "treats as a termination is needed to cover T5.",
        );
      }
    }

    // --------------------------------------------------------------- relaunch
    let page: Page;
    let shelf: ShelfReading;
    if (killed) {
      const relaunched = await relaunch(origin, media);
      session = { page: relaunched.page };
      page = session.page;
      lifecycle = mergeLifecycle(lifecycle, relaunched.carried);
      // The shelf FIRST, before the player is ever opened: this is what the
      // user sees when they reopen the app, and it must not be stale.
      shelf = await readShelf(page, origin, bookId, bookTitle, userId, durationMs);
      await openPlayer(page, origin, bookId, bookTitle);
    } else if (spec.termination === "in-app-nav") {
      page = session.page;
      shelf = await readShelf(page, origin, bookId, bookTitle, userId, durationMs);
      lifecycle = mergeLifecycle(lifecycle, await readLifecycle(page));
      await page.getByRole("link", { name: bookTitle, exact: true }).click();
      await settlePlayer(page);
    } else {
      page = session.page;
      await settlePlayer(page);
      lifecycle = mergeLifecycle(lifecycle, await readLifecycle(page));
      // A reload lands back on the player, so the shelf can only be read after
      // it. The flag says so rather than letting the row imply otherwise.
      const reading = await readShelf(page, origin, bookId, bookTitle, userId, durationMs);
      shelf = { ...reading, readBeforePlayer: false };
      await openPlayer(page, origin, bookId, bookTitle);
    }

    const settled = await readSettledPosition(page);
    const resumedUiMs = await readUiPosition(page);
    const rewindInputs = await readRewindInputs(page, userId, bookId);
    assertMarkerKeyShape(spec.scenario, userId, rewindInputs.markerKeysSeen);
    const rewind = expectedRewindMs(rewindInputs);
    if (rewind > 0) {
      notes.push(
        `smart rewind was due to apply ${rewind}ms (absence ${rewindInputs.msSinceLastPause}ms)`,
      );
    }

    const after = await page.evaluate(() => {
      const audio = document.querySelector("audio");
      const heading = document.querySelector("#book-title") ?? document.querySelector("h1");
      const chapter = document.querySelector(".player-chapter, [data-chapter-title]");
      return {
        rate: audio?.playbackRate ?? 1,
        title: (heading?.textContent ?? "").trim(),
        chapter: chapter ? (chapter.textContent ?? "").trim() : null,
      };
    });

    const behindMs = truePositionMs - settled.positionMs;
    const expectedChapter =
      active!.chapters.find(
        (chapter) => truePositionMs >= chapter.startMs && truePositionMs < chapter.endMs,
      )?.title ?? null;

    // ---------------------------------------------- did the write ever land?
    let serverPositionMs: number | null = null;
    let completedAfter: boolean | null = null;
    if (spec.network === "offline") {
      net.restore();
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect
        .poll(
          async () => {
            const [row] = await sql()<{ position_ms: number }[]>`
              SELECT position_ms FROM playback_states WHERE book_id = ${bookId}
            `;
            return row ? Number(row.position_ms) : -1;
          },
          {
            timeout: 60_000,
            message:
              "progress recorded while the network was gone never reached the server after " +
              "reconnect. That is a silently dropped user write.",
          },
        )
        .toBeGreaterThan(0);
    }
    const [serverRow] = await sql()<{ position_ms: number; completed: boolean }[]>`
      SELECT position_ms, completed FROM playback_states WHERE book_id = ${bookId}
    `;
    if (serverRow) {
      serverPositionMs = Number(serverRow.position_ms);
      completedAfter = serverRow.completed;
    }

    return {
      scenario: spec.scenario,
      engine: ENGINE,
      buildId: BUILD_ID,
      termination: spec.termination,
      network: spec.network,
      playedMs: Math.round(advancedToMs - startedAtMs),
      ticks: sample.ticks,
      startedAtMs: Math.round(startedAtMs),
      truePositionMs: Math.round(truePositionMs),
      resumedPositionMs: Math.round(settled.positionMs),
      resumedUiMs,
      shelf,
      behindMs: Math.round(behindMs),
      aheadMs: Math.round(-behindMs),
      expectedRewindMs: rewind,
      driftMs: Math.round(Math.abs(behindMs - rewind)),
      shelfDriftMs:
        shelf.sourceMs === null
          ? null
          : Math.round(Math.abs(truePositionMs - shelf.sourceMs - rewind)),
      // The bar belongs to the TERMINATING step. A composed row that navigates
      // and then dies with no callback gets the no-callback bar; one that gets
      // a pagehide gets the callback bar. Never the looser of the two by
      // default.
      barMs:
        spec.termination === "hard-kill" || spec.termination === "nav-then-hard-kill"
          ? HARD_KILL_BAR_MS
          : CALLBACK_BAR_MS,
      lifecycle,
      hiddenTransition,
      visibilityAtCallback,
      lifecycleBlocked: sample.blocked,
      settleMs: settled.settleMs,
      settleTrail: settled.trail,
      playbackRateBefore: rate,
      playbackRateAfter: after.rate,
      titleAfter: after.title,
      bookTitle,
      chapterAfter: after.chapter,
      expectedChapter,
      completedAfter,
      serverPositionMs,
      sessionSurvived,
      notes,
    };
  } finally {
    net.restore();
    await session.page.close().catch(() => undefined);
    await healDevice(origin, media);
  }
}

/**
 * Repeated open/close with NO listening.
 *
 * A single terminate→relaunch cycle structurally cannot see a position that
 * creeps backwards a little every time the app is opened. A user who opens the
 * app, glances at the shelf and closes it five times must not lose ground; "each
 * cycle passed the per-cycle bar" while the total walked back by minutes is a
 * FAILING outcome that a one-cycle matrix reports as green. The total is the
 * assertion that matters, and the intentional smart rewind is deliberately NOT
 * subtracted here — a rewind that re-applies on every open is exactly the creep
 * this is looking for, not an allowance.
 */
export async function measureCumulative(spec: {
  scenario: string;
  bookIndex: number;
  network: NetworkMode;
  cycles: number;
  playMs?: number;
  /**
   * Simulated time away from the book between cycles, in milliseconds.
   *
   * Without this the cycles run back to back in a few seconds, `rewindForAbsence`
   * returns 0 below 60_000 ms, and the smart-rewind branch is never entered at
   * all — so C1/C2 pass at 0 ms without ever testing the compounding backward
   * walk they exist to catch. That is a vacuous pass.
   *
   * The absence is applied by AGEING the marker the app itself wrote (see
   * `ageAbsenceMarker`), never by inventing one: if the app never wrote a pause
   * marker, this variant fails rather than quietly measuring the 0 ms tier.
   * Ageing a stored timestamp is exactly what waiting would do to it, and it is
   * the only way to reach the 30 s tier (>1 h) inside a test run.
   */
  absenceBetweenCyclesMs?: number;
}): Promise<CumulativeRow> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books, durationMs } = active!;
  const bookTitle = bookTitleFor(spec.bookIndex);
  const book = books.get(bookTitle);
  expect(book, `no book was imported for scenario "${spec.scenario}"`).toBeTruthy();
  const bookId = book!.id;
  const absenceMs = spec.absenceBetweenCyclesMs ?? null;
  await sql()`DELETE FROM playback_states WHERE book_id = ${bookId}`;

  net.restore();
  net.reset();

  const positions: number[] = [];
  const shelfPositions: Array<number | null> = [];
  const rewindObserved: number[] = [];
  const notes: string[] = [];
  let anchorMs = 0;
  let ticks = 0;
  let playedMs = 0;
  let media: CacheSnapshot | null = null;
  let session = await launch();
  try {
    // ----------------------------------------------- one real listening pass
    await openPlayer(session.page, origin, bookId, bookTitle);
    media = await snapshotCaches(session.page);
    if (spec.network === "offline") {
      net.cut();
      await proveOffline(session.page, origin);
    }
    const { startedAtMs } = await playForReal(session.page, spec.playMs ?? 8_500);
    const sample = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return { positionMs: audio ? audio.currentTime * 1000 : -1, ticks: probe?.ticks ?? 0 };
    });
    ticks = sample.ticks;
    playedMs = Math.round(sample.positionMs - startedAtMs);
    expect(ticks, "nothing played, so this cumulative row measured nothing").toBeGreaterThan(2);
    // Did the listening pass run this book off the end of the fixture?
    //
    // The books are ~24 s and the rows SHARE them, each starting wherever the
    // previous row left off, so a long matrix eventually pushes one to its end
    // — and a book stored at its end deliberately restarts from zero
    // (`resolveStartPosition`, BOOK_END_EPSILON_MS). Every cycle then reads a
    // clean 0, which is a fixture-capacity fact wearing the costume of a
    // product result. Named here so it can never be mistaken for one.
    const endOfBook = durationMs - BOOK_END_EPSILON_FOR_FIXTURE_MS;
    expect(
      Math.round(sample.positionMs),
      `${spec.scenario}: the listening pass ended at ${Math.round(sample.positionMs)}ms of a ` +
        `${durationMs}ms book, i.e. AT ITS END. A finished book restarts from zero by design, so ` +
        "every cycle below would read 0 and the row would measure fixture exhaustion rather than " +
        "resume. The rows share three ~24 s books and start where the previous row left off — run " +
        "this cumulative row standalone, or give it a book the matrix has not already used up.",
    ).toBeLessThan(endOfBook);
    // The absence variant needs the app to have written its own pause marker,
    // and only a real pause writes one. Pause through the UI before leaving.
    if (absenceMs !== null) {
      await pauseThroughUi(session.page);
      notes.push(`paused through the UI so the app wrote its own absence marker`);
    }
    // Leave gracefully: the cycles below are about what repeated OPENING does,
    // not about what a crash costs — that is the single-cycle matrix's job.
    await session.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await session.page.waitForTimeout(300);
    await expectPageDead(session.page, hardKill());

    // ------------------------------------- N cycles of open, look, close
    for (let cycle = 0; cycle < spec.cycles; cycle += 1) {
      session = await relaunch(origin, media!);
      const shelf = await readShelf(session.page, origin, bookId, bookTitle, userId, durationMs);
      // Age the marker BEFORE the open, because the open is what reads it.
      let rewind: number;
      if (absenceMs !== null) {
        const aged = await ageAbsenceMarker(session.page, userId, bookId, absenceMs);
        expect(
          aged,
          `${spec.scenario}: cycle ${cycle + 1} found no pause marker for this book, so the ` +
            "absence could not be applied and this variant would grade the 0 ms rewind tier " +
            "while claiming to grade the long-absence one. That is the vacuous pass this row " +
            "exists to prevent.",
        ).not.toBeNull();
        const inputs = await readRewindInputs(session.page, userId, bookId);
        assertMarkerKeyShape(spec.scenario, userId, inputs.markerKeysSeen);
        rewind = expectedRewindMs({ smartRewind: inputs.smartRewind, msSinceLastPause: absenceMs });
        expect(
          rewind,
          `${spec.scenario}: cycle ${cycle + 1} set an absence of ${absenceMs}ms but the app's own ` +
            "rewind ladder credits 0ms for it, so the rewind branch is still not being entered",
        ).toBeGreaterThan(0);
      } else {
        rewind = expectedRewindMs(await readRewindInputs(session.page, userId, bookId));
      }
      await openPlayer(session.page, origin, bookId, bookTitle);
      const settled = await readSettledPosition(session.page);
      positions.push(Math.round(settled.positionMs));
      shelfPositions.push(shelf.sourceMs === null ? null : Math.round(shelf.sourceMs));
      rewindObserved.push(rewind);
      if (cycle === 0) anchorMs = Math.round(settled.positionMs);
      await session.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await session.page.waitForTimeout(200);
      await expectPageDead(session.page, hardKill());
    }
  } finally {
    net.restore();
    await healDevice(origin, media);
  }

  const perCycleDeltaMs = positions.map((value, index) =>
    index === 0 ? 0 : positions[index - 1]! - value,
  );
  const firstShelf = shelfPositions[0];
  const lastShelf = shelfPositions[shelfPositions.length - 1];
  return {
    scenario: spec.scenario,
    engine: ENGINE,
    buildId: BUILD_ID,
    network: spec.network,
    cycles: spec.cycles,
    ticks,
    playedMs,
    anchorMs,
    positions,
    shelfPositions,
    perCycleDeltaMs,
    totalDriftMs: anchorMs - positions[positions.length - 1]!,
    shelfTotalDriftMs:
      typeof firstShelf === "number" && typeof lastShelf === "number"
        ? firstShelf - lastShelf
        : null,
    barMs: CALLBACK_BAR_MS,
    rewindObserved,
    absenceBetweenCyclesMs: absenceMs,
    notes,
  };
}

/**
 * Does an absence from ONE book move a DIFFERENT one?
 *
 * The pause marker was a single global key with no user and no book in it, so
 * the app could not tell "you have been away from this story for an hour" from
 * "you have been away from some story for an hour". Both books are paused for
 * real here, and only the first one's marker is aged: a correctly scoped app
 * leaves the second exactly where it was.
 */
export async function measureCrossBookAbsence(spec: {
  scenario: string;
  absentBookIndex: number;
  otherBookIndex: number;
  absenceMs: number;
  playMs?: number;
}): Promise<CrossBookRow> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books } = active!;
  expect(
    spec.absentBookIndex,
    "the absent book and the untouched book must be different books",
  ).not.toBe(spec.otherBookIndex);
  const absentTitle = bookTitleFor(spec.absentBookIndex);
  const otherTitle = bookTitleFor(spec.otherBookIndex);
  const absentId = books.get(absentTitle)!.id;
  const otherId = books.get(otherTitle)!.id;
  await sql()`DELETE FROM playback_states WHERE book_id IN (${absentId}, ${otherId})`;

  net.restore();
  net.reset();

  const notes: string[] = [];
  let media: CacheSnapshot | null = null;
  let session = await launch();
  let ticks = 0;
  let playedMs = 0;
  try {
    // The book that must not move: play it, pause it, leave it.
    await openPlayer(session.page, origin, otherId, otherTitle);
    media = await snapshotCaches(session.page);
    const { startedAtMs } = await playForReal(session.page, spec.playMs ?? 12_000);
    await pauseThroughUi(session.page);
    const sample = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return { positionMs: audio ? audio.currentTime * 1000 : -1, ticks: probe?.ticks ?? 0 };
    });
    ticks = sample.ticks;
    playedMs = Math.round(sample.positionMs - startedAtMs);
    const otherStoredMs = Math.round(sample.positionMs);
    expect(ticks, `${spec.scenario}: nothing played, so nothing was measured`).toBeGreaterThan(2);

    // The book the user really is away from: play it, pause it, leave it.
    await openPlayer(session.page, origin, absentId, absentTitle);
    await playForReal(session.page, 6_000);
    await pauseThroughUi(session.page);
    await session.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await session.page.waitForTimeout(300);
    await expectPageDead(session.page, hardKill());

    // Only the absent book's clock moves.
    session = await relaunch(origin, media!);
    const aged = await ageAbsenceMarker(session.page, userId, absentId, spec.absenceMs);
    expect(
      aged,
      `${spec.scenario}: "${absentTitle}" has no pause marker, so no absence could be created ` +
        "and a green here would mean nothing",
    ).not.toBeNull();
    const inputs = await readRewindInputs(session.page, userId, absentId);
    assertMarkerKeyShape(spec.scenario, userId, inputs.markerKeysSeen);
    const rewindIfLeakedMs = expectedRewindMs({
      smartRewind: inputs.smartRewind,
      msSinceLastPause: spec.absenceMs,
    });
    expect(
      rewindIfLeakedMs,
      `${spec.scenario}: an absence of ${spec.absenceMs}ms credits no rewind at all, so a leak ` +
        "would be invisible and this row proves nothing",
    ).toBeGreaterThan(0);

    // Open the OTHER book. It was paused seconds ago; it must not be rewound.
    await openPlayer(session.page, origin, otherId, otherTitle);
    const settled = await readSettledPosition(session.page);
    const otherResumedMs = Math.round(settled.positionMs);
    notes.push(`marker keys present: ${JSON.stringify(inputs.markerKeysSeen)}`);
    return {
      scenario: spec.scenario,
      engine: ENGINE,
      buildId: BUILD_ID,
      absenceMs: spec.absenceMs,
      absentBookTitle: absentTitle,
      otherBookTitle: otherTitle,
      otherStoredMs,
      otherResumedMs,
      leakedRewindMs: otherStoredMs - otherResumedMs,
      rewindIfLeakedMs,
      markerKeysSeen: inputs.markerKeysSeen,
      ticks,
      playedMs,
      notes,
    };
  } finally {
    net.restore();
    await session.page.close().catch(() => undefined);
    await healDevice(origin, media);
  }
}

// ---------------------------------------------------------------------------
// S1 — the stale queued position that outlives the write meant to replace it
// ---------------------------------------------------------------------------

/**
 * One row of the skip-ahead trap, graded on the SERVER as well as the client.
 *
 * The fields are deliberately raw. The interesting failure is a disagreement
 * between four independent records of "where the user is" — the audio element
 * at the instant of the kill, this device's durable local record, the unsent
 * row in the outbox, and the row Postgres ends up holding — and a summary that
 * folded them together could not show which one lied.
 */
export type StaleAheadRow = {
  scenario: string;
  engine: Engine;
  buildId: string;
  bookTitle: string;
  ticks: number;
  playedMs: number;
  /** The high-water mark this session reached, before the skip back. */
  advancedToMs: number;
  /** What "Back N seconds" is on this build, read off the control's own label. */
  skipBackMs: number;
  /** The outbox's row for this book, sampled just BEFORE the skip. */
  queuedBeforeSkipMs: number | null;
  /**
   * The outbox's row for this book AFTER the kill, read on the restore stub —
   * a same-origin document that runs no app code, so nothing has replayed or
   * rewritten it yet. This is the value replay is about to deliver.
   */
  queuedAfterKillMs: number | null;
  queuedAfterKillOccurredAt: string | null;
  queuedAfterKillCount: number;
  /** The durable local record that survived the kill. */
  localAfterKillMs: number | null;
  localAfterKillOccurredAt: number | null;
  /** Sampled off the element and carried forward to the instant of the SIGKILL. */
  truePositionMs: number;
  /**
   * How long the debounced post-rewind server write had to fire before the
   * process died. It must be under the 800 ms seek debounce: if that write
   * lands, it coalesces over the stale row and the trap was never armed.
   */
  skipToKillMs: number;
  /** `queuedAfterKill - true`: how far ahead the thing about to be replayed is. */
  armedAheadMs: number | null;
  /** Postgres after the relaunch drained the queue. */
  serverPositionMs: number | null;
  /** `server - true`. Positive means the server is serving content the user has not heard. */
  serverAheadMs: number | null;
  serverCompleted: boolean | null;
  outboxDrained: boolean;
  /** Where THIS device came back, which `localWinsOver` may protect on its own. */
  resumedPositionMs: number;
  resumedAheadMs: number;
  shelf: ShelfReading;
  lifecycle: string[];
  notes: string[];
};

/**
 * The ~12 second skip, end to end, in the engine of record.
 *
 * MECHANISM (measured before the fix: Postgres holding 15245 ms against a true
 * position of 3231 ms). The 15 s server heartbeat journals the position it sees
 * into the outbox. The user then presses "Back 15 seconds", which makes the
 * local record durable AT ONCE but only schedules the matching server write
 * 800 ms later. A SIGKILL inside that window takes the second write and leaves
 * the first, and replay delivers the stale row verbatim — carrying its ORIGINAL
 * `eventOccurredAt`, which the server compares against what IT holds rather
 * than against what the device knows. Postgres ends up authoritative for a
 * position the user rewound away from.
 *
 * WHY THE SERVER IS THE ASSERTION. On the device that made the mess, the damage
 * is invisible: its own local record is newer and `localWinsOver` prefers it, so
 * the player comes back in the right place. The row still records that, because
 * a client that ALSO skipped would be a worse failure. But the user this hurts
 * is the one on a second device, a fresh install, or cleared storage — for whom
 * the server is the only witness, and it is holding twelve seconds of a book
 * they have not heard.
 *
 * The trap has to be armed for the row to mean anything, and "armed" is not
 * assumed: the queued position is read twice (before the skip, and after the
 * kill from a document that runs no app code), and the interval between the
 * skip and the kill is measured against the debounce it has to beat.
 */
export async function measureStaleAheadReplay(spec: {
  scenario: string;
  bookIndex: number;
  /**
   * Playback before the skip. Must exceed the 15 s heartbeat interval, or the
   * only queued row is the one minted at position ~0 and there is nothing ahead
   * to replay.
   */
  playMs?: number;
}): Promise<StaleAheadRow> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books, durationMs } = active!;
  const bookTitle = bookTitleFor(spec.bookIndex);
  const book = books.get(bookTitle);
  expect(book, `no book was imported for scenario "${spec.scenario}"`).toBeTruthy();
  const bookId = book!.id;
  const playMs = spec.playMs ?? 16_500;
  const notes: string[] = [];

  net.restore();
  net.reset();

  let media: CacheSnapshot | null = null;
  let session = await launch();
  try {
    await session.page.goto(`${origin}/library`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await session.page.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 90_000,
    });
    await resetBookEverywhere(session.page, userId, bookId);
    await openPlayer(session.page, origin, bookId, bookTitle);
    media = await snapshotCaches(session.page);

    const openedAtMs = await readAudioPositionMs(session.page);
    expect(
      openedAtMs,
      `${spec.scenario}: the book opened at ${Math.round(openedAtMs)}ms after being reset to ` +
        "zero, so something this scenario does not control is still holding a position for it " +
        "and the headroom below cannot be trusted",
    ).toBeLessThan(1_000);
    expect(
      playMs + openedAtMs,
      `${spec.scenario}: ${playMs}ms of playback would run past the end of a ${durationMs}ms ` +
        "book. A finished book restarts from zero by design, so the skip below would have " +
        "nothing to skip back FROM and the row would measure fixture exhaustion.",
    ).toBeLessThan(durationMs - BOOK_END_EPSILON_FOR_FIXTURE_MS);

    // Offline is what puts the heartbeat in the OUTBOX rather than on the wire.
    // An accepted PATCH leaves no unsent intent, and there is then nothing for
    // replay to deliver stale.
    net.cut();
    await proveOffline(session.page, origin);

    const { startedAtMs } = await playForReal(session.page, playMs);
    const advancedToMs = await readAudioPositionMs(session.page);

    const queuedBefore = await readQueuedProgress(session.page, userId, bookId);
    const queuedBeforeSkipMs = queuedBefore[0]?.positionMs ?? null;

    const backControl = session.page.getByRole("button", { name: /^Back \d+ seconds$/ });
    const label = await backControl.getAttribute("aria-label");
    const skipBackMs = Number(/Back (\d+) seconds/.exec(label ?? "")?.[1] ?? 0) * 1_000;
    expect(
      skipBackMs,
      `${spec.scenario}: the skip-back control's label ("${label}") does not name a number of ` +
        "seconds, so the size of the rewind this row depends on is unknown",
    ).toBeGreaterThan(0);

    const lifecycleBeforeKill = await readLifecycle(session.page);
    const skippedAt = Date.now();
    await backControl.click();
    // Long enough for the seek and the SYNCHRONOUS local write, short enough
    // that the 800 ms debounced server write has not fired.
    await session.page.waitForTimeout(120);

    const sample = await session.page.evaluate(() => {
      const audio = document.querySelector("audio");
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return {
        positionMs: audio ? audio.currentTime * 1000 : -1,
        paused: audio?.paused ?? true,
        rate: audio?.playbackRate ?? 1,
        ticks: probe?.ticks ?? 0,
      };
    });
    const sampleReturnedAt = Date.now();
    expect(
      sample.paused,
      `${spec.scenario}: the audio was not playing when the process was killed, so this is not ` +
        "the interrupted-mid-listen case the trap needs",
    ).toBe(false);

    const killAt = Date.now();
    const truePositionMs = sample.positionMs + (killAt - sampleReturnedAt) * sample.rate;
    const killedPids = hardKill();
    const skipToKillMs = killAt - skippedAt;
    await expectPageDead(session.page, killedPids);

    // The network comes back BEFORE the relaunch: the replay is the step under
    // measurement, and a device that is still offline never performs it.
    net.restore();
    const relaunched = await relaunch(origin, media);
    session = { page: relaunched.page };
    const lifecycle = mergeLifecycle(lifecycleBeforeKill, relaunched.carried);

    // Read on the restore stub, which mounts no app: nothing has replayed,
    // superseded or settled this row yet, so this is exactly what the replay
    // about to happen will be working from.
    const queuedAfterKill = await readQueuedProgress(session.page, userId, bookId);
    const localAfterKill = await readLocalRecord(session.page, userId, bookId);
    const queuedAfterKillMs = queuedAfterKill[0]?.positionMs ?? null;
    const armedAheadMs =
      queuedAfterKillMs === null ? null : Math.round(queuedAfterKillMs - truePositionMs);

    // Now let the app run. Mounting the provider is what replays the queue.
    await session.page.goto(`${origin}/library`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await session.page.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 90_000,
    });
    let outboxDrained = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const remaining = await readQueuedProgress(session.page, userId, bookId);
      if (remaining.length === 0) {
        outboxDrained = true;
        break;
      }
      await session.page.waitForTimeout(500);
    }
    if (!outboxDrained) {
      notes.push(
        "the queued progress row never left the outbox within 60s, so the server value below is " +
          "what the server held BEFORE the replay rather than after it",
      );
    }

    // The server, before this device is allowed to open the player again — the
    // player itself writes, and a value read after it would be the client's
    // repair rather than what replay delivered.
    const server = await readServerProgress(bookId);
    const shelf = await readShelf(session.page, origin, bookId, bookTitle, userId, durationMs);
    await openPlayer(session.page, origin, bookId, bookTitle);
    const settled = await readSettledPosition(session.page);

    return {
      scenario: spec.scenario,
      engine: ENGINE,
      buildId: BUILD_ID,
      bookTitle,
      ticks: sample.ticks,
      playedMs: Math.round(advancedToMs - startedAtMs),
      advancedToMs: Math.round(advancedToMs),
      skipBackMs,
      queuedBeforeSkipMs,
      queuedAfterKillMs,
      queuedAfterKillOccurredAt: queuedAfterKill[0]?.eventOccurredAt ?? null,
      queuedAfterKillCount: queuedAfterKill.length,
      localAfterKillMs: localAfterKill.positionMs,
      localAfterKillOccurredAt: localAfterKill.occurredAt,
      truePositionMs: Math.round(truePositionMs),
      skipToKillMs,
      armedAheadMs,
      serverPositionMs: server?.positionMs ?? null,
      serverAheadMs: server ? Math.round(server.positionMs - truePositionMs) : null,
      serverCompleted: server?.completed ?? null,
      outboxDrained,
      resumedPositionMs: Math.round(settled.positionMs),
      resumedAheadMs: Math.round(settled.positionMs - truePositionMs),
      shelf,
      lifecycle,
      notes,
    };
  } finally {
    net.restore();
    await session.page.close().catch(() => undefined);
    await healDevice(origin, media);
  }
}

// ---------------------------------------------------------------------------
// F2 — finishing one book, then opening another
// ---------------------------------------------------------------------------

/** Does opening the next book un-finish the one just finished? */
export type CompletionRow = {
  scenario: string;
  engine: Engine;
  buildId: string;
  finishedBookTitle: string;
  nextBookTitle: string;
  /** Every witness, immediately after the book was marked finished. */
  finishedLocalBefore: boolean | null;
  finishedMirrorBefore: boolean | null;
  finishedServerBefore: boolean | null;
  /** The same witnesses, after the NEXT book was opened. */
  finishedLocalAfter: boolean | null;
  finishedMirrorAfter: boolean | null;
  finishedServerAfter: boolean | null;
  /** The shelf's own words for the finished book, after the next one was opened. */
  finishedStatusText: string | null;
  /** Proof the next book really did load in the same session as the first. */
  nextBookLoaded: boolean;
  /** The user action this row is built on: the book genuinely reached its end. */
  endedObserved: boolean;
  /** Proof the provider still held the finished book when the next one was opened. */
  previousBookWasStillActive: boolean;
  ticks: number;
  notes: string[];
};

/**
 * Finish a book, open the next one, and ask whether the first is still
 * finished — locally, in the mirror the shelf renders from, and in Postgres.
 *
 * WHY IT WAS INVISIBLE. Every other row in this oracle measures ONE book, so a
 * write that a second book's arrival makes to the FIRST book is structurally
 * unobservable: there is no second book. `loadBook` persists the previous
 * book's position as it switches, and it used to hand that write a literal
 * `completed: false`.
 *
 * THE NAVIGATION HAS TO BE CLIENT-SIDE, and only one route in this app is.
 * `loadBook` reaches its previous-book branch only when the provider is still
 * holding the first book, and the provider lives in the app shell — so any
 * navigation that reloads the document drops `activeBookRef`, and with no
 * previous book there is no write and the defect cannot fire. MEASURED: going
 * out through the player's Library control and back in through the next book's
 * card lands on a shell whose audio element has no `src` at all
 * (`{"audioCount":1,"currentSrc":"","srcAttribute":null}` — a freshly mounted
 * provider), so that route cannot reach it.
 *
 * So this drives the path the defect was actually reported on: AUTOPLAY-NEXT.
 * Both books go into a collection, the "Play the next book in a collection"
 * preference is switched on through the real settings control, and the first
 * book is played to its end. `FullPlayer` then calls `router.push` itself and
 * the second book arrives without the document ever being replaced — which is
 * exactly why the finished book is ALWAYS the previous one on this path.
 *
 * That the document really did survive is not assumed: a marker is written onto
 * `window` before the first book ends and read back after the second has
 * loaded. A row that lost it is UNCOVERED, never a pass.
 */
export async function measureCompletionAcrossBooks(spec: {
  scenario: string;
  finishedBookIndex: number;
  nextBookIndex: number;
}): Promise<CompletionRow> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books, durationMs } = active!;
  expect(
    spec.finishedBookIndex,
    "the finished book and the next book must be different books",
  ).not.toBe(spec.nextBookIndex);
  const finishedTitle = bookTitleFor(spec.finishedBookIndex);
  const nextTitle = bookTitleFor(spec.nextBookIndex);
  const finishedId = books.get(finishedTitle)!.id;
  const nextId = books.get(nextTitle)!.id;
  const notes: string[] = [];

  net.restore();
  net.reset();

  let media: CacheSnapshot | null = null;
  const session = await launch();
  try {
    await session.page.goto(`${origin}/library`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await session.page.waitForSelector("[data-launch-ready]", {
      state: "attached",
      timeout: 90_000,
    });
    await resetBookEverywhere(session.page, userId, finishedId);
    await resetBookEverywhere(session.page, userId, nextId);

    // The autoplay-next path needs a collection holding both books in order,
    // and the preference switched on. `getNextBookInCollection` reads Postgres
    // when `/books/:id` renders, so the membership has to exist before the
    // first book is opened.
    const collectionName = `Resume Oracle ${spec.scenario}`.slice(0, 60);
    const collection = await session.page.evaluate(
      async ([target, name]) => {
        const response = await fetch(`${target}/api/collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        return {
          status: response.status,
          body: (await response.json()) as { collection?: { id?: string } },
        };
      },
      [origin, collectionName] as const,
    );
    expect(
      collection.status,
      `${spec.scenario}: could not create the collection the autoplay-next path needs`,
    ).toBe(201);
    const collectionId = collection.body.collection?.id;
    expect(collectionId, `${spec.scenario}: the collection came back with no id`).toBeTruthy();
    for (const id of [finishedId, nextId]) {
      const added = await session.page.evaluate(
        async ([target, list, bookId]) => {
          const response = await fetch(`${target}/api/collections/${list}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookId, include: true }),
          });
          return response.status;
        },
        [origin, collectionId!, id] as const,
      );
      expect(added, `${spec.scenario}: adding ${id} to the collection failed`).toBe(200);
    }

    // The preference goes on through the real control, not through the API, so
    // the provider's own state carries it rather than only the database.
    await session.page.goto(`${origin}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    const autoplayToggle = session.page.getByRole("checkbox", {
      name: /Play the next book in a collection/,
    });
    await expect(
      autoplayToggle,
      `${spec.scenario}: the settings page has no autoplay-next control, so the path this row ` +
        "drives cannot be switched on",
    ).toBeVisible({ timeout: 60_000 });
    if (!(await autoplayToggle.isChecked())) await autoplayToggle.check();
    await expect(autoplayToggle).toBeChecked();
    notes.push("autoplay-next switched on through the settings control");

    await openPlayer(session.page, origin, finishedId, finishedTitle);
    await expect(
      session.page.getByText(
        new RegExp(`Up next in ${collectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      ),
      `${spec.scenario}: the player does not believe there is a next book in this collection, so ` +
        "no autoplay-next navigation will happen and this row cannot reach the defect",
    ).toBeVisible({ timeout: 30_000 });
    media = await snapshotCaches(session.page);
    // Real listening first: a book "finished" with no playback behind it is not
    // the journey, and `positionChangedRef` would refuse the write anyway.
    const { startedAtMs } = await playForReal(session.page, 6_000);
    const ticks = await session.page.evaluate(() => {
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return probe?.ticks ?? 0;
    });
    expect(
      ticks,
      `${spec.scenario}: nothing played, so the book was never really listened to`,
    ).toBeGreaterThan(2);
    notes.push(`listened from ${Math.round(startedAtMs)}ms for 6000ms before finishing`);

    // Finished by REACHING THE END, not by a menu item. `markEnded` is the path
    // the autoplay-next journey runs down — the one where the finished book is
    // always the previous book — and it is the only way to finish a book without
    // the user having asked a dialog for it. The scrubber is a real control with
    // a 1000 ms step; `fill` moves it without a pointer drag, which is the
    // keyboard path and seeks immediately.
    const scrubber = session.page.locator('input[aria-label="Audiobook position"]');
    await expect(
      scrubber,
      `${spec.scenario}: the player has no position control, so the book cannot be taken to its ` +
        "end and this row cannot create the state it exists to protect",
    ).toBeVisible({ timeout: 30_000 });
    const nearEndMs = Math.max(0, Math.floor((durationMs - 3_000) / 1_000) * 1_000);
    // Written before the book ends, read after the next one has loaded. It
    // survives a `router.push` and nothing else, so it is the proof that the
    // provider — and with it the finished book — was never torn down.
    await session.page.evaluate(() => {
      (window as unknown as { __f2SameDocument?: number }).__f2SameDocument = Date.now();
    });
    await scrubber.fill(String(nearEndMs));
    await expect
      .poll(() => session.page.evaluate(() => document.querySelector("audio")?.ended ?? false), {
        timeout: 60_000,
        message:
          `${spec.scenario}: the book never reached its end after being scrubbed to ` +
          `${nearEndMs}ms of ${durationMs}ms, so it was never finished`,
      })
      .toBe(true);
    const endedObserved = await session.page.evaluate(
      () => document.querySelector("audio")?.ended ?? false,
    );
    notes.push(`scrubbed to ${nearEndMs}ms of ${durationMs}ms and played to the end`);

    // Read AT ONCE, and never by polling the server.
    //
    // The autoplay push fires off the same `ended` event, so on a build with the
    // defect the un-finishing write is already in flight; a poll waiting for the
    // server to say `true` would time out and report "the book was never
    // finished", which is a precondition's words for the very failure this row
    // exists to name. The reliable "before" witness is this device's own durable
    // record, written synchronously inside `markEnded`. The server's value here
    // is recorded as a snapshot, not gated on.
    const finishedLocalBefore = (await readLocalRecord(session.page, userId, finishedId)).completed;
    const finishedMirrorBefore = await readMirrorCompleted(session.page, userId, finishedId);
    const finishedServerBefore = (await readServerProgress(finishedId))?.completed ?? null;

    // The app navigates itself. Nothing here clicks anything.
    await session.page.waitForURL(new RegExp(`/books/${nextId}`), { timeout: 60_000 });
    await settlePlayer(session.page);
    const activeProbe = await session.page.evaluate(() => ({
      sameDocument:
        (window as unknown as { __f2SameDocument?: number }).__f2SameDocument !== undefined,
      audioCount: document.querySelectorAll("audio").length,
      currentSrc: document.querySelector("audio")?.currentSrc ?? null,
    }));
    const previousBookWasStillActive = activeProbe.sameDocument;
    notes.push(`after the autoplay-next push: ${JSON.stringify(activeProbe)}`);
    if (!previousBookWasStillActive) {
      notes.push(
        "UNCOVERED-RISK: the document was replaced on the way to the next book, so the provider " +
          "was rebuilt with no previous book and there is no write to the finished one for this " +
          "row to grade",
      );
    }
    const nextBookLoaded = (
      await session.page.evaluate(() => {
        const heading = document.querySelector("#book-title") ?? document.querySelector("h1");
        return (heading?.textContent ?? "").trim();
      })
    ).includes(nextTitle);

    // The write to the PREVIOUS book travels the same outbox as everything
    // else, so give it the same chance to land as a real one would get — and
    // then confirm the server has stopped moving, so the value read below is a
    // settled answer rather than whichever half of the race was caught.
    await session.page.waitForTimeout(3_000);
    let settledServer = (await readServerProgress(finishedId))?.completed ?? null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await session.page.waitForTimeout(1_000);
      const again = (await readServerProgress(finishedId))?.completed ?? null;
      if (again === settledServer) break;
      settledServer = again;
    }

    const finishedLocalAfter = (await readLocalRecord(session.page, userId, finishedId)).completed;
    const finishedMirrorAfter = await readMirrorCompleted(session.page, userId, finishedId);
    const finishedServerAfter = (await readServerProgress(finishedId))?.completed ?? null;
    const shelf = await readShelf(
      session.page,
      origin,
      finishedId,
      finishedTitle,
      userId,
      durationMs,
    );

    return {
      scenario: spec.scenario,
      engine: ENGINE,
      buildId: BUILD_ID,
      finishedBookTitle: finishedTitle,
      nextBookTitle: nextTitle,
      finishedLocalBefore,
      finishedMirrorBefore,
      finishedServerBefore,
      finishedLocalAfter,
      finishedMirrorAfter,
      finishedServerAfter,
      finishedStatusText: shelf.statusText,
      nextBookLoaded,
      endedObserved,
      previousBookWasStillActive,
      ticks,
      notes,
    };
  } finally {
    net.restore();
    await session.page.close().catch(() => undefined);
    await healDevice(origin, media);
  }
}

// ---------------------------------------------------------------------------
// X2 — two devices, one account, one book
// ---------------------------------------------------------------------------

/**
 * Put a page back in the foreground the same way `background()` takes it out.
 *
 * The engine cannot produce either state for real (see `background()`), so both
 * edges are synthesised the same way and the row says so. What matters for the
 * republish case is not whether the platform reported the transition — it is
 * that the app's handler runs with `document.visibilityState === "visible"`,
 * which is exactly what a user returning to a long-open tab produces, and which
 * is what this arranges.
 */
async function foreground(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  });
}

/** Two devices on one account, both mounting a real player on the same book. */
export type TwoDeviceRow = {
  scenario: string;
  engine: Engine;
  buildId: string;
  bookTitle: string;
  deviceIdA: string | null;
  deviceIdB: string | null;
  /** Where A listened to, and what the server held when A stopped. */
  deviceAListenedToMs: number;
  serverAfterAMs: number | null;
  /** Where B's player STARTED — a cross-device resume in its own right. */
  deviceBStartedAtMs: number;
  /** Where B listened to, and what the server held when B stopped. */
  deviceBListenedToMs: number;
  serverAfterBMs: number | null;
  /** The furthest the user has actually reached, across both devices. */
  furthestMs: number;
  /** What A's own handler read when the stale tab came back to the foreground. */
  visibilityAtForeground: string | null;
  /** The server AFTER A was foregrounded. This is where the republish shows. */
  serverAfterForegroundMs: number | null;
  /** `furthest - server`: positive means A's stale tab clobbered B's newer write. */
  clobberedMs: number | null;
  /**
   * The server after A's tab was NAVIGATED AWAY FROM — the `pagehide` edge,
   * which this build flushes unconditionally. A second chance for a stale tab
   * to publish, measured separately from the visible edge.
   */
  serverAfterANavigatedMs: number | null;
  /** `furthest - serverAfterANavigated`. Positive means the pagehide edge clobbered. */
  clobberedByPagehideMs: number | null;
  /** A's own durable record on both sides of that navigation. */
  localABeforeNav: LocalRecord;
  localAAfterNav: LocalRecord;
  /** Where each device comes back when its player is opened again. */
  deviceAResumedMs: number;
  deviceBResumedMs: number;
  /** Positive means that device would skip content the user has not heard. */
  deviceAAheadMs: number;
  deviceBAheadMs: number;
  /** Positive means that device threw away listening the user really did. */
  deviceALostMs: number;
  deviceBLostMs: number;
  /**
   * The rewind the app's own ladder credits each device on its final open.
   * Both devices paused through the UI, and the cross-device leg takes real
   * wall-clock time, so a bounded smart rewind is legitimate here and is
   * subtracted from the "lost" columns rather than being charged to the bug.
   */
  rewindCreditedA: number;
  rewindCreditedB: number;
  ticksA: number;
  ticksB: number;
  /** Guard: a second import that created a SECOND book makes every row above vacuous. */
  booksForUser: number;
  notes: string[];
};

/**
 * Two real devices, one account, one book — the axis the oracle could not see.
 *
 * Every other row here runs on ONE device, so a write that one device makes
 * over another device's newer position is structurally invisible: there is no
 * other device. `tests/sync/two-device-convergence.spec.ts` has two, but it
 * drives them through an in-page sync driver and never mounts a player or reads
 * a start position, so the player's own write paths are not on the wire.
 *
 * The journey: A listens and stops. B — a genuinely separate storage session
 * with its own device id — picks the book up, resumes where A left it, and
 * listens further. Then A's tab, still open and still holding its old position,
 * comes back to the foreground.
 *
 * Three questions, all of which need two devices to ask:
 *   1. Did B resume where A left off? (`deviceBStartedAtMs`)
 *   2. Did A's stale tab republish over B's newer write? (`clobberedMs`)
 *   3. Does either device now come back AHEAD of anything the user has heard?
 *
 * Both devices stay alive throughout, so nothing here hard-kills: a SIGKILL is
 * aimed at every renderer this run started, and B's is one of them.
 */
export async function measureTwoDeviceResume(spec: {
  scenario: string;
  bookIndex: number;
  playMsA?: number;
  playMsB?: number;
}): Promise<TwoDeviceRow> {
  const active = fixture;
  expect(active, "resumeFixture() was never built").toBeTruthy();
  const { userId, origin, net, books, durationMs } = active!;
  const bookTitle = bookTitleFor(spec.bookIndex);
  const bookId = books.get(bookTitle)!.id;
  const playMsA = spec.playMsA ?? 6_000;
  const playMsB = spec.playMsB ?? 8_000;
  const notes: string[] = [];

  net.restore();
  net.reset();

  const { browser, context: contextA } = await openDevice();
  const pageA = trackCrash(await contextA.newPage());
  let contextB: BrowserContext | null = null;
  try {
    await pageA.goto(`${origin}/library`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await pageA.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
    await resetBookEverywhere(pageA, userId, bookId);

    // ------------------------------------------------------------- device A
    await openPlayer(pageA, origin, bookId, bookTitle);
    const { startedAtMs: startedA } = await playForReal(pageA, playMsA);
    await pauseThroughUi(pageA);
    const deviceAListenedToMs = Math.round(await readAudioPositionMs(pageA));
    const ticksA = await pageA.evaluate(() => {
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return probe?.ticks ?? 0;
    });
    expect(ticksA, `${spec.scenario}: device A never played`).toBeGreaterThan(2);
    await expect
      .poll(async () => (await readServerProgress(bookId))?.positionMs ?? -1, {
        timeout: 60_000,
        message:
          `${spec.scenario}: device A's position never reached the server, so device B ` +
          "would have nothing to resume from and the cross-device journey never starts",
      })
      .toBeGreaterThan(startedA + 1_000);
    const serverAfterAMs = (await readServerProgress(bookId))?.positionMs ?? null;

    // A goes to the background and STAYS OPEN, holding its position. This is
    // the tab left running while the user picks the book up somewhere else.
    await background(pageA);
    const deviceIdA = await pageA.evaluate(() => localStorage.getItem("chapterline:device-id"));

    // ------------------------------------------------------------- device B
    // Cookies only. Copying A's localStorage would copy A's device id, and two
    // "devices" sharing one id makes every ordering assertion below vacuous.
    const cookies = (await contextA.storageState()).cookies;
    contextB = await browser.newContext({
      ...devices["iPhone 15"],
      serviceWorkers: "allow",
      storageState: { cookies, origins: [] },
    });
    await contextB.addInitScript({ content: PROBE_SCRIPT });
    const pageB = trackCrash(await contextB.newPage());
    await pageB.goto(`${origin}/library`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await pageB.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
    await assertEngineCanStoreMedia(pageB);
    await pageB.reload({ waitUntil: "domcontentloaded" });
    await pageB.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 60_000,
    });
    await pageB.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
    // B has the account but not the bytes. It gets them the way a second device
    // does: the same file, which the server recognises by fingerprint and
    // re-points onto the book that already exists.
    await pageB.setInputFiles('input[aria-label="Choose an MP3 file to import"]', {
      name: `${bookTitle}.mp3`,
      mimeType: "audio/mpeg",
      buffer: buildLongMp3(FIXTURE_REPEAT, 64 + spec.bookIndex * 16, bookTitle),
    });
    await expect
      .poll(
        () =>
          pageB.evaluate((title) => {
            const card = [...document.querySelectorAll("article.book-item")].find(
              (node) => (node.querySelector(".book-title")?.textContent ?? "").trim() === title,
            );
            if (!card) return "no card";
            return card.querySelector(".book-device-missing") ? "not on this device" : "on device";
          }, bookTitle),
        {
          timeout: 120_000,
          message:
            `${spec.scenario}: "${bookTitle}" never reached device B, so B cannot mount a ` +
            "player and there is no second device in this row",
        },
      )
      .toBe("on device");
    const [bookCount] = await sql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM books WHERE owner_id = ${userId} AND title = ${bookTitle}
    `;
    const booksForUser = Number(bookCount!.count);
    expect(
      booksForUser,
      `${spec.scenario}: device B's import created a SECOND "${bookTitle}" instead of being ` +
        "matched to the existing one, so the two devices are not on the same book and nothing " +
        "below compares anything",
    ).toBe(1);

    await openPlayer(pageB, origin, bookId, bookTitle);
    const deviceBStartedAtMs = Math.round((await readSettledPosition(pageB)).positionMs);
    await playForReal(pageB, playMsB);
    await pauseThroughUi(pageB);
    const deviceBListenedToMs = Math.round(await readAudioPositionMs(pageB));
    const ticksB = await pageB.evaluate(() => {
      const probe = (window as unknown as { __resumeProbe?: { ticks: number } }).__resumeProbe;
      return probe?.ticks ?? 0;
    });
    expect(ticksB, `${spec.scenario}: device B never played`).toBeGreaterThan(2);
    // Read HERE, not on first load: `getDeviceId()` mints lazily, on the first
    // write, so a context that has only browsed reports null and the check
    // below would fail for a reason that has nothing to do with identity.
    const deviceIdB = await pageB.evaluate(() => localStorage.getItem("chapterline:device-id"));
    expect(
      !!deviceIdB && !!deviceIdA && deviceIdB !== deviceIdA,
      `${spec.scenario}: device ids were ${deviceIdA} and ${deviceIdB} — either one is missing ` +
        "or the two contexts minted the same one, so these are two tabs and not two devices and " +
        "every ordering rule below is vacuous",
    ).toBe(true);
    await expect
      .poll(async () => (await readServerProgress(bookId))?.positionMs ?? -1, {
        timeout: 60_000,
        message:
          `${spec.scenario}: device B's listening never reached the server, so there is ` +
          "no newer write for A's stale tab to be tested against",
      })
      .toBeGreaterThan(deviceAListenedToMs + 1_000);
    const serverAfterBMs = (await readServerProgress(bookId))?.positionMs ?? null;
    const furthestMs = Math.max(deviceAListenedToMs, deviceBListenedToMs);

    // ------------------------------------------- A comes back to the foreground
    const visibilityAtForeground = await foreground(pageA);
    // Long enough for a flush, a PATCH and the server to have written it. If
    // nothing is published this window costs the row nothing.
    await pageA.waitForTimeout(5_000);
    const serverAfterForegroundMs = (await readServerProgress(bookId))?.positionMs ?? null;

    // ------------------------------------------------- what each device shows
    // The rewind each device is owed is read BEFORE its open, because the open
    // is what consumes the marker.
    const inputsB = await readRewindInputs(pageB, userId, bookId);
    assertMarkerKeyShape(spec.scenario, userId, inputsB.markerKeysSeen);
    const rewindCreditedB = expectedRewindMs(inputsB);
    await openPlayer(pageB, origin, bookId, bookTitle);
    const deviceBResumedMs = Math.round((await readSettledPosition(pageB)).positionMs);

    // A's tab is now navigated away from — a plain document navigation, which
    // is what closing the tab or following a link does. It delivers `pagehide`,
    // which this build flushes UNCONDITIONALLY by design. That is a second edge
    // on which a stale tab can publish, so this row measures A's own record and
    // the server on both sides of it rather than assuming the edge is harmless.
    const localABeforeNav = await readLocalRecord(pageA, userId, bookId);
    await pageA.goto(`${origin}/library`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await pageA.waitForSelector("[data-launch-ready]", { state: "attached", timeout: 90_000 });
    await pageA.waitForTimeout(3_000);
    const localAAfterNav = await readLocalRecord(pageA, userId, bookId);
    const serverAfterANavigatedMs = (await readServerProgress(bookId))?.positionMs ?? null;
    notes.push(
      `device A local record before its own navigation ${JSON.stringify(localABeforeNav)}, ` +
        `after ${JSON.stringify(localAAfterNav)}`,
    );
    const inputsA = await readRewindInputs(pageA, userId, bookId);
    assertMarkerKeyShape(spec.scenario, userId, inputsA.markerKeysSeen);
    const rewindCreditedA = expectedRewindMs(inputsA);
    await openPlayer(pageA, origin, bookId, bookTitle);
    const deviceAResumedMs = Math.round((await readSettledPosition(pageA)).positionMs);

    if (deviceBStartedAtMs < deviceAListenedToMs - 2_000) {
      notes.push(
        `device B started at ${deviceBStartedAtMs}ms for a book device A left at ` +
          `${deviceAListenedToMs}ms`,
      );
    }
    notes.push(`book duration ${durationMs}ms`);

    return {
      scenario: spec.scenario,
      engine: ENGINE,
      buildId: BUILD_ID,
      bookTitle,
      deviceIdA,
      deviceIdB,
      deviceAListenedToMs,
      serverAfterAMs,
      deviceBStartedAtMs,
      deviceBListenedToMs,
      serverAfterBMs,
      furthestMs,
      visibilityAtForeground,
      serverAfterForegroundMs,
      clobberedMs:
        serverAfterForegroundMs === null ? null : Math.round(furthestMs - serverAfterForegroundMs),
      serverAfterANavigatedMs,
      clobberedByPagehideMs:
        serverAfterANavigatedMs === null ? null : Math.round(furthestMs - serverAfterANavigatedMs),
      localABeforeNav,
      localAAfterNav,
      deviceAResumedMs,
      deviceBResumedMs,
      deviceAAheadMs: Math.round(deviceAResumedMs - furthestMs),
      deviceBAheadMs: Math.round(deviceBResumedMs - furthestMs),
      deviceALostMs: Math.round(furthestMs - deviceAResumedMs),
      deviceBLostMs: Math.round(furthestMs - deviceBResumedMs),
      rewindCreditedA,
      rewindCreditedB,
      ticksA,
      ticksB,
      booksForUser,
      notes,
    };
  } finally {
    net.restore();
    await pageA.close().catch(() => undefined);
    // B's renderer belongs to this run, so a later scenario's SIGKILL would
    // find it. It does not outlive this row.
    await contextB?.close().catch(() => undefined);
  }
}
