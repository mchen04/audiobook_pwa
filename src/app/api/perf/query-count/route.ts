import { queryCountingEnabled, readQueryCount, resetQueryCount } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test-only instrument for the launch benchmark, which needs to prove that a
 * warm launch issues zero Postgres queries. It is wired to the same flag that
 * pins the process to the local throwaway database, so it does not exist in a
 * production process, and it returns a count only — never any row data.
 *
 * GET /api/perf/query-count?reset=1 reads the counter and then zeroes it.
 */
export function GET(request: Request): Response {
  if (!queryCountingEnabled) return new Response("Not found", { status: 404 });
  const count = readQueryCount();
  if (new URL(request.url).searchParams.get("reset") === "1") resetQueryCount();
  return Response.json(
    { count },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate" } },
  );
}
