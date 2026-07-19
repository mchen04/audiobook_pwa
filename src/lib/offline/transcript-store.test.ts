import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import type { BookTranscript } from "@/domain/transcript";

import { database } from "./db";
import {
  deleteAllTranscriptsForUser,
  deleteBookTranscript,
  getChapterTranscript,
  getTranscriptChapterIndexes,
  storeBookTranscript,
} from "./transcript-store";

function transcript(chapters: number[]): BookTranscript {
  return {
    engine: "kokoro",
    language: "en",
    chapters: chapters.map((index) => ({
      index,
      granularity: "word" as const,
      sentences: [
        {
          text: `Sentence for chapter ${index}.`,
          startMs: 0,
          endMs: 1000,
          words: [{ text: "Sentence", startMs: 0, endMs: 400, charStart: 0, charEnd: 8 }],
        },
      ],
    })),
  };
}

beforeEach(async () => {
  const db = await database();
  await db.clear("transcripts");
});

describe("transcript store", () => {
  it("stores per-chapter records and reads them back", async () => {
    await storeBookTranscript("user-1", "book-1", transcript([0, 1, 4]));

    expect(await getTranscriptChapterIndexes("user-1", "book-1")).toEqual([0, 1, 4]);
    const chapter = await getChapterTranscript("user-1", "book-1", 1);
    expect(chapter?.granularity).toBe("word");
    expect(chapter?.sentences[0]?.text).toBe("Sentence for chapter 1.");
    expect(await getChapterTranscript("user-1", "book-1", 2)).toBeUndefined();
  });

  it("replaces existing cues on re-import", async () => {
    await storeBookTranscript("user-1", "book-1", transcript([0, 1, 2]));
    await storeBookTranscript("user-1", "book-1", transcript([0]));

    expect(await getTranscriptChapterIndexes("user-1", "book-1")).toEqual([0]);
  });

  it("keeps books and users isolated", async () => {
    await storeBookTranscript("user-1", "book-1", transcript([0]));
    await storeBookTranscript("user-1", "book-2", transcript([0, 1]));
    await storeBookTranscript("user-2", "book-1", transcript([0]));

    const db = await database();
    await deleteBookTranscript(db, "user-1", "book-1");

    expect(await getTranscriptChapterIndexes("user-1", "book-1")).toEqual([]);
    expect(await getTranscriptChapterIndexes("user-1", "book-2")).toEqual([0, 1]);
    expect(await getTranscriptChapterIndexes("user-2", "book-1")).toEqual([0]);
  });

  it("wipes a whole user without touching others", async () => {
    await storeBookTranscript("user-1", "book-1", transcript([0]));
    await storeBookTranscript("user-1", "book-2", transcript([0]));
    await storeBookTranscript("user-2", "book-1", transcript([0]));

    await deleteAllTranscriptsForUser("user-1");

    expect(await getTranscriptChapterIndexes("user-1", "book-1")).toEqual([]);
    expect(await getTranscriptChapterIndexes("user-1", "book-2")).toEqual([]);
    expect(await getTranscriptChapterIndexes("user-2", "book-1")).toEqual([0]);
  });

  it("orders chapters correctly past single digits", async () => {
    const indexes = [0, 2, 10, 11, 100];
    await storeBookTranscript("user-1", "book-1", transcript(indexes));
    expect(await getTranscriptChapterIndexes("user-1", "book-1")).toEqual(indexes);
  });
});
