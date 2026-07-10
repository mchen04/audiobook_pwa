import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { withMutation, withQuery } from "@/server/api/route-handler";
import { db } from "@/server/db/client";
import { collectionBooks, collections } from "@/server/db/schema";

export const runtime = "nodejs";

export const GET = withQuery(async ({ session }) => {
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      bookId: collectionBooks.bookId,
      position: collectionBooks.position,
    })
    .from(collections)
    .leftJoin(collectionBooks, eq(collectionBooks.collectionId, collections.id))
    .where(eq(collections.userId, session.user.id))
    .orderBy(asc(collections.name), asc(collectionBooks.position));

  const byId = new Map<string, { id: string; name: string; bookIds: string[] }>();
  for (const row of rows) {
    const entry = byId.get(row.id) || { id: row.id, name: row.name, bookIds: [] };
    if (row.bookId) entry.bookIds.push(row.bookId);
    byId.set(row.id, entry);
  }
  return Response.json({ collections: [...byId.values()] });
});

const createSchema = z.object({ name: z.string().trim().min(1).max(120) });

export const POST = withMutation(
  createSchema,
  "Give the collection a name.",
  async ({ session, data }) => {
    const [created] = await db
      .insert(collections)
      .values({ userId: session.user.id, name: data.name })
      .onConflictDoNothing()
      .returning({ id: collections.id, name: collections.name });
    if (!created) {
      return Response.json(
        { error: "A collection with this name already exists." },
        { status: 409 },
      );
    }
    return Response.json({ collection: { ...created, bookIds: [] } }, { status: 201 });
  },
);
