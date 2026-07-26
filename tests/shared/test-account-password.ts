/**
 * The password every e2e test account is registered with.
 *
 * Derived from `HARK_TEST_ACCOUNT_PASSWORD`, which `scripts/test-db.mjs`
 * generates into the gitignored `.env.test` on first run, rather than written
 * here as a literal. The accounts live in a throwaway Docker Postgres, so these
 * were never real credentials — which is exactly why they should not be in git:
 * a committed string shaped like a password teaches a secret scanner, and
 * everyone reading its output, to wave the next one through, and the one that
 * matters looks identical.
 *
 * Per-account suffixing keeps them distinct without a second source of truth,
 * and keeps them STABLE across runs — the accounts persist in the local database
 * between suites, so a password regenerated per run would leave `ensureAccount`
 * unable to sign into an account it had already registered.
 */
export function testAccountPassword(label: string): string {
  const base = process.env.HARK_TEST_ACCOUNT_PASSWORD;
  if (!base) {
    throw new Error(
      "HARK_TEST_ACCOUNT_PASSWORD is not set. Run `node scripts/test-db.mjs`, which generates it " +
        "into .env.test — the e2e accounts are registered with a password derived from it.",
    );
  }
  // The register route requires >= 12 characters; the generated base already is,
  // and the suffix only lengthens it.
  return `${base}-${label}`;
}
