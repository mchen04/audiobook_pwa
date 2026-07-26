// Loads one explicitly named env file into process.env.
//
// Next's own loader always reads `.env.local`, which silently couples every
// tool that uses it to the developer's production credentials. Test tooling
// names its file instead: `.env.test` by default, overridable with the
// HARK_ENV_FILE variable or a `--env-file=<path>` argument.
//
// Values already present in process.env win, so CI can override any single key
// without editing the file.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_TEST_ENV_FILE = ".env.test";

/**
 * Resolves which env file to load, in precedence order:
 * an explicit `--env-file=<path>` argument, then HARK_ENV_FILE, then fallback.
 *
 * @param {{ argv?: string[], fallback?: string }} [options]
 * @returns {string} an absolute path
 */
export function resolveEnvFile(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const fallback = options.fallback ?? DEFAULT_TEST_ENV_FILE;

  const inlineFlag = argv.find((argument) => argument.startsWith("--env-file="));
  const separateFlagIndex = argv.indexOf("--env-file");
  const fromArgv = inlineFlag
    ? inlineFlag.slice("--env-file=".length)
    : separateFlagIndex >= 0
      ? argv[separateFlagIndex + 1]
      : undefined;

  const chosen = fromArgv || process.env.HARK_ENV_FILE || fallback;
  return path.resolve(process.cwd(), chosen);
}

/**
 * @param {string} contents
 * @returns {Record<string, string>}
 */
export function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Reads the env file and applies it to process.env without overwriting values
 * that are already set.
 *
 * @param {string} file absolute or cwd-relative path
 * @param {{ required?: boolean }} [options]
 * @returns {{ file: string, loaded: boolean, keys: string[] }}
 */
export function loadEnvFile(file, options = {}) {
  const absolute = path.resolve(process.cwd(), file);
  if (!existsSync(absolute)) {
    if (options.required !== false) {
      throw new Error(
        `Missing env file ${path.relative(process.cwd(), absolute)}.\n` +
          `Copy .env.test.example to .env.test, then run: node scripts/test-db.mjs`,
      );
    }
    return { file: absolute, loaded: false, keys: [] };
  }

  const parsed = parseEnvFile(readFileSync(absolute, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { file: absolute, loaded: true, keys: Object.keys(parsed) };
}
