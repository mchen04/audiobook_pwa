import { asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withMutation, withQuery } from "@/server/api/route-handler";
import { db } from "@/server/db/client";
import { collectionBooks, collections } from "@/server/db/schema";

export const runtime = "nodejs";

const querySchema = z.object({ bookId: z.uuid() });

export const GET = withQuery(async ({ request, session }) => {
  const query = querySchema.safeParse({ bookId: new URL(request.url).searchParams.get("bookId") });
  if (!query.success) return Response.json({ error: "Invalid book." }, { status: 400 });
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      includesBook: sql<boolean>`exists (
        select 1 from ${collectionBooks}
        where ${collectionBooks.collectionId} = ${collections.id}
          and ${collectionBooks.bookId} = ${query.data.bookId}
      )`,
    })
    .from(collections)
    .where(eq(collections.userId, session.user.id))
    .orderBy(asc(collections.name), asc(collections.id))
    .limit(100);

  return Response.json({ collections: rows });
});

const createSchema = z.object({ name: z.string().trim().min(1).max(120) });
const MAX_COLLECTIONS = 100;

export const POST = withMutation(
  createSchema,
  "Give the collection a name.",
  async ({ session, data }) => {
    const created = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`collections:${session.user.id}`}, 0))`,
      );
      const [total] = await transaction
        .select({ value: count() })
        .from(collections)
        .where(eq(collections.userId, session.user.id));
      if ((total?.value ?? 0) >= MAX_COLLECTIONS) return "limit" as const;
      const [row] = await transaction
        .insert(collections)
        .values({ userId: session.user.id, name: data.name })
        .onConflictDoNothing()
        .returning({ id: collections.id, name: collections.name });
      return row || null;
    });
    if (created === "limit") {
      return Response.json(
        { error: `An account can have up to ${MAX_COLLECTIONS} collections.` },
        { status: 409 },
      );
    }
    if (!created) {
      return Response.json(
        { error: "A collection with this name already exists." },
        { status: 409 },
      );
    }
    return Response.json({ collection: { ...created, includesBook: false } }, { status: 201 });
  },
);
