import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { isValidChapterSequence } from "@/domain/mp3";
import { withMutation } from "@/server/api/route-handler";
import { expectRow } from "@/server/books/queries";
import { db } from "@/server/db/client";
import { books, chapters, mediaAssets } from "@/server/db/schema";
import { validateUploadMetadata } from "@/server/media/filename";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reverend-Insanity-scale ceilings, not upload limits: the audio bytes never
// reach the server, so these only bound what one registration may write.
const MAX_CHAPTERS = 10_000;
const MAX_DURATION_MS = 1_000 * 60 * 60 * 1_000; // 1,000 hours
const MAX_BYTE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
const CHAPTER_INSERT_BATCH = 2_000;

const chapterSchema = z.object({
  position: z.number().int().min(0),
  title: z.string().min(1).max(500),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
});

const registerSchema = z.object({
  fileName: z.string().min(1).max(8192),
  byteSize: z.number().int().positive().max(MAX_BYTE_SIZE),
  durationMs: z.number().int().positive().max(MAX_DURATION_MS),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().min(1).max(240),
  narrator: z.string().trim().min(1).max(240).nullable(),
  chapterDiagnostic: z.string().trim().min(1).max(300).nullable(),
  chapters: z.array(chapterSchema).min(1).max(MAX_CHAPTERS),
});

/**
 * Registers a book whose MP3 stays on the user's device: the browser parsed
 * the file locally and sends only metadata. The server owns identity, sync,
 * and organization — never the audio bytes.
 */
export const POST = withMutation(
  registerSchema,
  "The book registration is invalid.",
  async ({ session, data }) => {
    let filename: string;
    try {
      filename = validateUploadMetadata(data.fileName, "audio/mpeg");
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 415 });
    }
    if (!isValidChapterSequence(data.chapters, data.durationMs)) {
      return Response.json({ error: "The chapter list is inconsistent." }, { status: 422 });
    }

    const [duplicate] = await db
      .select({ id: books.id })
      .from(mediaAssets)
      .innerJoin(books, eq(books.id, mediaAssets.bookId))
      .where(
        and(
          eq(mediaAssets.sha256, data.fingerprint),
          eq(books.ownerId, session.user.id),
          eq(books.status, "ready"),
        ),
      )
      .limit(1);
    if (duplicate) {
      return Response.json(
        { error: "This MP3 is already in your library.", existingBookId: duplicate.id },
        { status: 409 },
      );
    }

    const bookId = await db.transaction(async (transaction) => {
      const created = expectRow(
        await transaction
          .insert(books)
          .values({
            ownerId: session.user.id,
            title: data.title,
            author: data.author,
            narrator: data.narrator,
            chapterDiagnostic: data.chapterDiagnostic,
            status: "ready",
          })
          .returning({ id: books.id }),
      );
      await transaction.insert(mediaAssets).values({
        bookId: created.id,
        originalFilename: filename,
        mimeType: "audio/mpeg",
        byteSize: data.byteSize,
        sha256: data.fingerprint,
        durationMs: data.durationMs,
      });
      for (let start = 0; start < data.chapters.length; start += CHAPTER_INSERT_BATCH) {
        await transaction.insert(chapters).values(
          data.chapters.slice(start, start + CHAPTER_INSERT_BATCH).map((chapter) => ({
            bookId: created.id,
            ...chapter,
          })),
        );
      }
      return created.id;
    });

    return Response.json({ bookId }, { status: 201 });
  },
);
