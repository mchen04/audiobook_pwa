import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  interpretTranscriptBytes,
  interpretTranscriptDocument,
  maxDecompressedTranscriptBytes,
  TranscriptParseError,
} from "./transcript";

const FIXTURES = join(__dirname, "..", "..", "tests", "fixtures", "transcripts");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

describe("interpretTranscriptDocument", () => {
  it("accepts the canonical word-granularity fixture", () => {
    const transcript = interpretTranscriptDocument(loadFixture("valid-word.json"));
    expect(transcript.engine).toBe("edge");
    expect(transcript.chapters.map((chapter) => chapter.index)).toEqual([0, 1]);
    const first = transcript.chapters[0]!.sentences[0]!;
    expect(first.text).toBe("It was a dark and stormy night.");
    const dark = first.words[3]!;
    expect(first.text.slice(dark.charStart, dark.charEnd)).toBe("dark");
  });

  it("accepts the canonical sentence-granularity fixture", () => {
    const transcript = interpretTranscriptDocument(loadFixture("valid-sentence.json"));
    expect(transcript.chapters[0]!.granularity).toBe("sentence");
    expect(transcript.chapters[0]!.sentences.every((sentence) => sentence.words.length === 0)).toBe(
      true,
    );
  });

  it("maps normalized speech onto the written token", () => {
    const transcript = interpretTranscriptDocument(loadFixture("valid-word.json"));
    const sentence = transcript.chapters[1]!.sentences[0]!;
    const spoken = sentence.words.slice(1, 4);
    expect(spoken.map((word) => word.text)).toEqual(["one", "twenty", "three"]);
    for (const word of spoken) {
      expect(sentence.text.slice(word.charStart, word.charEnd)).toBe("123");
    }
  });

  const mutations: Array<[string, (document: Record<string, unknown>) => void]> = [
    ["wrong version", (document) => Object.assign(document, { version: 2 })],
    ["wrong format", (document) => Object.assign(document, { format: "nope" })],
    ["missing chapters", (document) => delete document.chapters],
    [
      "duplicate chapter index",
      (document) => {
        const chapters = document.chapters as Array<Record<string, unknown>>;
        chapters.push({ ...chapters[0] });
      },
    ],
    [
      "sentence timing out of order",
      (document) => {
        const chapters = document.chapters as Array<{
          sentences: Array<{ start: number; end: number }>;
        }>;
        chapters[0]!.sentences[1]!.start = 0;
        chapters[0]!.sentences[1]!.end = 0;
        chapters[0]!.sentences[0]!.start = 100;
      },
    ],
    [
      "word char range out of bounds",
      (document) => {
        const chapters = document.chapters as Array<{
          sentences: Array<{ words: Array<{ charEnd: number }> }>;
        }>;
        chapters[0]!.sentences[0]!.words[0]!.charEnd = 10_000;
      },
    ],
    [
      "granularity mismatch",
      (document) => {
        const chapters = document.chapters as Array<{ granularity: string }>;
        chapters[0]!.granularity = "sentence";
      },
    ],
    [
      "unknown granularity",
      (document) => {
        const chapters = document.chapters as Array<{ granularity: string }>;
        chapters[0]!.granularity = "chunk";
      },
    ],
  ];

  it.each(mutations)("rejects %s", (_name, mutate) => {
    const document = loadFixture("valid-word.json") as Record<string, unknown>;
    mutate(document);
    expect(() => interpretTranscriptDocument(document)).toThrow(TranscriptParseError);
  });
});

describe("interpretTranscriptBytes", () => {
  it("round-trips fixture bytes", () => {
    const bytes = new TextEncoder().encode(
      readFileSync(join(FIXTURES, "valid-word.json"), "utf-8"),
    );
    const transcript = interpretTranscriptBytes(bytes, 60 * 60 * 1000);
    expect(transcript.chapters).toHaveLength(2);
  });

  it("rejects bytes above the duration-scaled cap", () => {
    const durationMs = 1000;
    const cap = maxDecompressedTranscriptBytes(durationMs);
    const bytes = new Uint8Array(cap + 1);
    expect(() => interpretTranscriptBytes(bytes, durationMs)).toThrow(TranscriptParseError);
  });

  it("rejects malformed JSON and invalid UTF-8", () => {
    expect(() => interpretTranscriptBytes(new TextEncoder().encode("{nope"), 1000)).toThrow(
      TranscriptParseError,
    );
    expect(() => interpretTranscriptBytes(new Uint8Array([0xff, 0xfe, 0x80]), 1000)).toThrow(
      TranscriptParseError,
    );
  });

  it("scales the cap with duration under an absolute ceiling", () => {
    expect(maxDecompressedTranscriptBytes(0)).toBe(1024 * 1024);
    expect(maxDecompressedTranscriptBytes(60_000)).toBe(1024 * 1024 + 600 * 60);
    expect(maxDecompressedTranscriptBytes(Number.MAX_SAFE_INTEGER)).toBe(128 * 1024 * 1024);
  });
});
