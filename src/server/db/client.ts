import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/server/env";

import * as schema from "./schema";

const globalDatabase = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
  harkQueryCount?: number;
};

// Test-only query counter. HARK_REQUIRE_LOCAL_DB is set only by the harnesses
// that pin this process to the throwaway local database, so a production
// process never installs the hook and never pays for it. It exists so the
// launch benchmark can prove "zero Postgres queries on the warm paint path"
// by measurement rather than by argument.
export const queryCountingEnabled = process.env.HARK_REQUIRE_LOCAL_DB === "1";

export function readQueryCount(): number {
  return globalDatabase.harkQueryCount ?? 0;
}

export function resetQueryCount(): void {
  globalDatabase.harkQueryCount = 0;
}

const sqlClient =
  globalDatabase.sqlClient ??
  postgres(env.DATABASE_URL, {
    max: process.env.NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Neon's pooled connection strings sit behind PgBouncer in transaction
    // mode, which cannot host named prepared statements.
    prepare: false,
    ...(queryCountingEnabled
      ? {
          debug: () => {
            globalDatabase.harkQueryCount = (globalDatabase.harkQueryCount ?? 0) + 1;
          },
        }
      : {}),
  });

if (process.env.NODE_ENV !== "production") globalDatabase.sqlClient = sqlClient;

export const db = drizzle(sqlClient, { schema });

/** The transaction handle `db.transaction` passes to its callback. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
