import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The second half of "`/offline` is not a second UI" — the half a browser
 * cannot see.
 *
 * `library-parity.spec.ts` proves the two-screen split is gone from the user's
 * view. This proves it is gone from the repository: the old Downloads screen's
 * files do not exist, nothing imports them, and no test anywhere still asserts
 * the behaviour they had. A dead component nobody renders is one refactor away
 * from being rendered again, and a test that still asserts the old contract is
 * a trap for whoever changes this next.
 *
 * This is a static check, so it also has to defend against being vacuous. A
 * scanner that walked the wrong directory would report "no violations" forever;
 * the self-check at the bottom fails if the sweep did not actually reach the
 * files it is supposed to be reading.
 */

const ROOT = process.cwd();
const SCANNED_DIRECTORIES = ["src", "tests", "public"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".mjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", ".git", "test-results"]);

/** Files whose existence anywhere in the repository is itself the failure. */
const REMOVED_FILES = ["offline-library.tsx", "offline.css"];

/**
 * Text that only appears in code or tests written against the two-screen split.
 *
 * Each pattern names the behaviour it forbids, so a failure explains itself
 * rather than pointing at a regular expression.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /offline-library|OfflineLibrary/,
    why: "the old separate Downloads/offline library component",
  },
  {
    pattern: /offline\.css/,
    why: "the old separate Downloads/offline stylesheet",
  },
  {
    pattern: /toHaveURL\(\s*(?:\/[^)]*\\\/offline|["'][^"']*\/offline["'])/,
    why: "an assertion that a visitor STAYS on /offline; it must land in /library",
  },
  {
    pattern: /getByRole\(\s*["']heading["']\s*,\s*\{\s*name:\s*["']Downloads["']/,
    why: "an assertion that Downloads is a screen with its own heading",
  },
  {
    pattern: /["'`]\/downloads["'`]/,
    why: "a route for a separate Downloads screen",
  },
];

/** This spec is allowed to name the things it forbids. */
const SELF = path.join("tests", "parity", "one-library.spec.ts");

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = path.join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, found);
    else if (SCANNED_EXTENSIONS.has(path.extname(entry))) found.push(full);
  }
  return found;
}

const files = SCANNED_DIRECTORIES.flatMap((directory) => walk(path.join(ROOT, directory))).map(
  (file) => path.relative(ROOT, file),
);

test("the old two-screen Downloads UI is gone from the repository", () => {
  // The sweep must have actually happened. Without this, a wrong root or a
  // broken extension filter would report a clean repository forever.
  expect(
    files.length,
    "the source sweep found almost nothing, so its clean result means nothing",
  ).toBeGreaterThan(100);
  for (const anchor of [
    path.join("src", "components", "library", "library-client.tsx"),
    path.join("src", "app", "offline", "page.tsx"),
    path.join("tests", "e2e", "iphone-pwa.spec.ts"),
    path.join("tests", "parity", "library-parity.spec.ts"),
  ]) {
    expect(
      files,
      `the sweep never reached ${anchor}, so it is not reading the repository`,
    ).toContain(anchor);
  }

  expect(
    files.filter((file) => REMOVED_FILES.includes(path.basename(file))),
    "the old two-screen Downloads UI's files are still in the repository",
  ).toStrictEqual([]);

  const violations: string[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    const contents = readFileSync(path.join(ROOT, file), "utf8");
    for (const rule of FORBIDDEN) {
      const match = rule.pattern.exec(contents);
      if (match) violations.push(`${file}: ${rule.why} — found ${JSON.stringify(match[0])}`);
    }
  }
  expect(
    violations,
    "something in this repository still describes the old two-screen split. `/offline` renders " +
      "the same shell and the same LibraryClient as `/library`, and Downloads is a facet of the " +
      "one library, so nothing may still assert otherwise.",
  ).toStrictEqual([]);
});

test("the forbidden-pattern scanner can actually detect what it forbids", () => {
  // A regression guard for the guard. If one of these patterns stopped matching
  // the thing it names, the check above would go quietly green forever.
  const samples: Array<[string, RegExp]> = [
    ['import { OfflineLibrary } from "@/components/offline-library";', FORBIDDEN[0]!.pattern],
    ['import "@/app/styles/offline.css";', FORBIDDEN[1]!.pattern],
    ["await expect(page).toHaveURL(/\\/offline/);", FORBIDDEN[2]!.pattern],
    ['await expect(page).toHaveURL("/offline");', FORBIDDEN[2]!.pattern],
    ['page.getByRole("heading", { name: "Downloads" })', FORBIDDEN[3]!.pattern],
    ['await page.goto("/downloads");', FORBIDDEN[4]!.pattern],
  ];
  for (const [sample, pattern] of samples) {
    expect(pattern.test(sample), `pattern ${pattern} no longer matches ${sample}`).toBe(true);
  }
  // And it must not fire on the code that is actually correct today.
  const current = readFileSync(path.join(ROOT, "src", "components", "app-shell.tsx"), "utf8");
  for (const rule of FORBIDDEN) {
    expect(rule.pattern.test(current), `${rule.why}: false positive on app-shell.tsx`).toBe(false);
  }
});
