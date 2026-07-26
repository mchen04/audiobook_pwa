// Hand-written types for assert-local-database.mjs. See env-file.d.mts for why
// the implementation is plain ESM.

export declare function describeDatabaseHost(url: string): string;

export declare function assertLocalDatabase(
  url: string | undefined,
  options?: { context?: string },
): string;
