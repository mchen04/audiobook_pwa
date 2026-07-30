import { randomInt } from "node:crypto";

const DEFAULT_SEED_COUNT = 12;
const DEFAULT_SEED_BASE = 20_260_101;
type SeedEnvironment = Record<string, string | undefined>;

export function positiveInt(value: string | undefined, fallback: number, label = "value"): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Turn the exploratory shorthand into an explicit list before Playwright
 * splits discovery and execution across processes.
 */
export function materializeRandomSyncSeeds(env: SeedEnvironment = process.env): void {
  if (env.HARK_SYNC_SEED !== undefined || env.HARK_SYNC_SEED_BASE !== "random") return;
  const count = positiveInt(env.HARK_SYNC_SEEDS, DEFAULT_SEED_COUNT, "HARK_SYNC_SEEDS");
  const base = randomInt(1, 1_000_000_000 - count);
  env.HARK_SYNC_SEED = Array.from({ length: count }, (_, index) => base + index).join(",");
}

export function resolveSyncSeeds(env: SeedEnvironment = process.env): number[] {
  if (env.HARK_SYNC_SEED !== undefined) {
    const tokens = env.HARK_SYNC_SEED.split(",");
    if (tokens.length === 0 || tokens.some((value) => value.trim() === "")) {
      throw new Error("HARK_SYNC_SEED must contain one or more comma-separated seeds");
    }
    return tokens.map((value) => positiveInt(value.trim(), 0, "each HARK_SYNC_SEED"));
  }
  const count = positiveInt(env.HARK_SYNC_SEEDS, DEFAULT_SEED_COUNT, "HARK_SYNC_SEEDS");
  const base = positiveInt(env.HARK_SYNC_SEED_BASE, DEFAULT_SEED_BASE, "HARK_SYNC_SEED_BASE");
  return Array.from({ length: count }, (_, index) => base + index);
}
