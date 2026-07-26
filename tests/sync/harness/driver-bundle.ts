import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Bundles `driver-entry.ts` — and, transitively, the real `src/lib/offline/*`
 * sync engine — into one script the suite injects with `addInitScript`.
 *
 * The whole point of bundling the production sources instead of restating them
 * is that a defect injected into `src/**` must reach this suite. If this file
 * ever started shipping a copy of the engine, the fail-demo would stop going
 * red and the suite would be theater.
 */

type EsbuildModule = {
  version: string;
  build(options: Record<string, unknown>): Promise<{ outputFiles?: Array<{ text: string }> }>;
};

// Anchored on the repo root rather than `import.meta.url`: Playwright compiles
// this file to CommonJS, where `import.meta` does not exist.
const require_ = createRequire(path.join(process.cwd(), "package.json"));

/**
 * esbuild is not a direct dependency of this repo and `package.json` is out of
 * bounds for this suite, so it is resolved from the pnpm store that drizzle-kit
 * and vitest already put there. Resolution is by discovery, never a pinned
 * version path, and a miss fails loudly rather than silently skipping.
 */
function loadEsbuild(): EsbuildModule {
  try {
    return require_("esbuild") as EsbuildModule;
  } catch {
    // Fall through to the store scan below.
  }
  const store = path.join(process.cwd(), "node_modules/.pnpm");
  const candidates = readdirSync(store)
    .filter((entry) => entry.startsWith("esbuild@"))
    .sort()
    .reverse()
    .map((entry) => path.join(store, entry, "node_modules/esbuild/lib/main.js"));
  for (const candidate of candidates) {
    try {
      return require_(candidate) as EsbuildModule;
    } catch {
      continue;
    }
  }
  throw new Error(
    "The sync suite bundles the production sync engine into the page and needs esbuild to do " +
      `it. None was resolvable from ${store}. Run \`pnpm install\` and retry.`,
  );
}

let cached: Promise<string> | null = null;

export function buildDriverScript(): Promise<string> {
  cached ??= build();
  return cached;
}

async function build(): Promise<string> {
  const esbuild = loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [path.join(process.cwd(), "tests/sync/harness/driver-entry.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["safari16"],
    // Matches tsconfig `paths`, so the bundle pulls the same files Next builds.
    alias: { "@": path.join(process.cwd(), "src") },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const text = result.outputFiles?.[0]?.text;
  if (!text) throw new Error("esbuild produced no output for the sync driver.");
  // A bundle that lost the engine would leave every assertion below vacuous.
  for (const marker of ["queueMutation", "replayQueuedMutations", "applyPullBatch"]) {
    if (!text.includes(marker)) {
      throw new Error(
        `The sync driver bundle does not contain \`${marker}\`, so it is not carrying the ` +
          "production sync engine and nothing this suite asserts would be about the product.",
      );
    }
  }
  return text;
}
