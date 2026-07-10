import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/server/env";

import * as schema from "./schema";

const globalDatabase = globalThis as unknown as {
  sqlClient?: ReturnType<typeof postgres>;
};

const sqlClient =
  globalDatabase.sqlClient ??
  postgres(env.DATABASE_URL, {
    max: process.env.NODE_ENV === "production" ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") globalDatabase.sqlClient = sqlClient;

export const db = drizzle(sqlClient, { schema });
