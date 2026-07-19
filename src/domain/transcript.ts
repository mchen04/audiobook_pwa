import { z } from "zod";

/**
 * Read-along transcript embedded in generated audiobooks (Epub Listener GEOB
 * frame; contract in that repo's docs/transcript-format.md). All timestamps
 * are integer milliseconds RELATIVE TO CHAPTER START; `chapterIndex` refers
 * to the MP3's own embedded chapter order. Transcript content never leaves
 * the device.
 */

export const TRANSCRIPT_GEOB_DESCRIPTION = "EPUB_LISTENER_TRANSCRIPT";
export const TRANSCRIPT_FORMAT = "epub-listener-transcript";
export const TRANSCRIPT_VERSION = 1;

/** Reject transcript frames larger than this before even inflating. */
export const MAX_COMPRESSED_TRANSCRIPT_BYTES = 24 * 1024 * 1024;
const MAX_DECOMPRESSED_ABSOLUTE_BYTES = 128 * 1024 * 1024;

/** Decompressed cap scales with book length (~3x real narration density). */
export function maxDecompressedTranscriptBytes(durationMs: number): number {
  const durationSeconds = Math.max(0, Math.ceil(durationMs / 1000));
  return Math.min(MAX_DECOMPRESSED_ABSOLUTE_BYTES, 1024 * 1024 + 600 * durationSeconds);
}

export type TranscriptWord = {
  text: string;
  startMs: number;
  endMs: number;
  /** Char range into the sentence text marking the displayed word. */
  charStart: number;
  charEnd: number;
};

export type TranscriptSentence = {
  text: string;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
};

export type TranscriptChapter = {
  /** Index into the book's embedded chapter list; the array may be sparse. */
  index: number;
  granularity: "word" | "sentence";
  sentences: TranscriptSentence[];
};

export type BookTranscript = {
  engine: string;
  language: string;
  chapters: TranscriptChapter[];
};

export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptParseError";
  }
}

const nonNegativeInt = z.number().int().min(0);

const wordSchema = z.object({
  text: z.string().min(1),
  start: nonNegativeInt,
  end: nonNegativeInt,
  charStart: nonNegativeInt,
  charEnd: nonNegativeInt,
});

const sentenceSchema = z.object({
  text: z.string(),
  start: nonNegativeInt,
  end: nonNegativeInt,
  words: z.array(wordSchema),
});

const chapterSchema = z.object({
  index: nonNegativeInt,
  title: z.string(),
  granularity: z.enum(["word", "sentence"]),
  sentences: z.array(sentenceSchema),
});

const documentSchema = z.object({
  format: z.literal(TRANSCRIPT_FORMAT),
  version: z.literal(TRANSCRIPT_VERSION),
  producer: z.string(),
  engine: z.string(),
  generationKey: z.string(),
  language: z.string(),
  chapters: z.array(chapterSchema),
});

/**
 * Validates a decoded transcript document. Throws TranscriptParseError on any
 * contract violation; callers treat that as "this book has no transcript".
 */
export function interpretTranscriptDocument(value: unknown): BookTranscript {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) {
    throw new TranscriptParseError(`Transcript rejected: ${parsed.error.issues[0]?.message}`);
  }
  const { engine, language, chapters } = parsed.data;

  let previousIndex = -1;
  const cleanChapters = chapters.map((chapter) => {
    if (chapter.index <= previousIndex) {
      throw new TranscriptParseError("Transcript rejected: chapter indexes must increase");
    }
    previousIndex = chapter.index;

    let previousSentenceStart = 0;
    let sawWords = false;
    const sentences = chapter.sentences.map((sentence) => {
      if (!sentence.text.trim()) {
        throw new TranscriptParseError("Transcript rejected: empty sentence text");
      }
      if (sentence.end < sentence.start || sentence.start < previousSentenceStart) {
        throw new TranscriptParseError("Transcript rejected: sentence timing out of order");
      }
      previousSentenceStart = sentence.start;

      let previousWordStart = 0;
      const words = sentence.words.map((word) => {
        if (word.end < word.start || word.start < previousWordStart) {
          throw new TranscriptParseError("Transcript rejected: word timing out of order");
        }
        previousWordStart = word.start;
        if (word.charEnd < word.charStart || word.charEnd > sentence.text.length) {
          throw new TranscriptParseError("Transcript rejected: word char range out of bounds");
        }
        return {
          text: word.text,
          startMs: word.start,
          endMs: word.end,
          charStart: word.charStart,
          charEnd: word.charEnd,
        };
      });
      sawWords ||= words.length > 0;
      return { text: sentence.text, startMs: sentence.start, endMs: sentence.end, words };
    });

    if (chapter.granularity === "sentence" && sawWords) {
      throw new TranscriptParseError("Transcript rejected: sentence granularity carries words");
    }
    if (chapter.granularity === "word" && sentences.length > 0 && !sawWords) {
      throw new TranscriptParseError("Transcript rejected: word granularity has no words");
    }
    return { index: chapter.index, granularity: chapter.granularity, sentences };
  });

  return { engine, language, chapters: cleanChapters };
}

/** Decode + validate raw JSON bytes, enforcing the duration-scaled size cap. */
export function interpretTranscriptBytes(bytes: Uint8Array, durationMs: number): BookTranscript {
  if (bytes.byteLength > maxDecompressedTranscriptBytes(durationMs)) {
    throw new TranscriptParseError(
      `Transcript rejected: ${bytes.byteLength} bytes exceeds the cap for this duration`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TranscriptParseError("Transcript rejected: not valid UTF-8 JSON");
  }
  return interpretTranscriptDocument(decoded);
}
