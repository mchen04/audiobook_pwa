// Hand-written types for env-file.mjs. The implementation stays plain ESM so
// the Node-run scripts in scripts/ can import it without a build step, while
// playwright.config.ts still type-checks.

export declare const DEFAULT_TEST_ENV_FILE: string;

export declare function resolveEnvFile(options?: { argv?: string[]; fallback?: string }): string;

export declare function parseEnvFile(contents: string): Record<string, string>;

export declare function loadEnvFile(
  file: string,
  options?: { required?: boolean },
): { file: string; loaded: boolean; keys: string[] };
