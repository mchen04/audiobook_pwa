import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBlob, type IAudioMetadata } from "music-metadata";
import { describe, expect, it } from "vitest";

import { TranscriptParseError } from "@/domain/transcript";

import { extractTranscript } from "./transcript-import";

const FIXTURES = join(__dirname, "..", "..", "tests", "fixtures", "transcripts");

async function fixtureMetadata(): Promise<IAudioMetadata> {
  const bytes = readFileSync(join(FIXTURES, "tiny-book.mp3"));
  return parseBlob(new Blob([bytes]), { duration: false });
}

function metadataWithGeob(frame: Record<string, unknown> | null): IAudioMetadata {
  return {
    format: {},
    common: {},
    native: {
      "ID3v2.3": frame ? [{ id: "GEOB", value: frame }] : [],
    },
  } as unknown as IAudioMetadata;
}

function geobFrame(data: Uint8Array) {
  return {
    type: "application/gzip",
    filename: "transcript.json.gz",
    description: "EPUB_LISTENER_TRANSCRIPT",
    data,
  };
}

describe("extractTranscript", () => {
  it("reads the embedded transcript from a generated fixture book", async () => {
    const metadata = await fixtureMetadata();
    const transcript = await extractTranscript(metadata, 8 * 1000);
    expect(transcript).not.toBeNull();
    expect(transcript!.chapters.map((chapter) => chapter.index)).toEqual([0, 1]);
    const first = transcript!.chapters[0]!.sentences[0]!;
    expect(first.text).toBe("Hello there my friend.");
    expect(first.words.map((word) => word.text)).toEqual(["Hello", "there", "my", "friend"]);
    const friend = first.words[3]!;
    expect(first.text.slice(friend.charStart, friend.charEnd)).toBe("friend");
  });

  it("returns null for books without a transcript frame", async () => {
    await expect(extractTranscript(metadataWithGeob(null), 1000)).resolves.toBeNull();
    const otherGeob = { ...geobFrame(new Uint8Array([1])), description: "SOMETHING_ELSE" };
    await expect(extractTranscript(metadataWithGeob(otherGeob), 1000)).resolves.toBeNull();
  });

  it("rejects corrupt gzip payloads", async () => {
    const metadata = metadataWithGeob(geobFrame(new Uint8Array([1, 2, 3, 4])));
    await expect(extractTranscript(metadata, 1000)).rejects.toThrow(TranscriptParseError);
  });

  it("rejects tampered JSON inside valid gzip", async () => {
    const metadata = metadataWithGeob(
      geobFrame(new Uint8Array(gzipSync(JSON.stringify({ format: "nope" })))),
    );
    await expect(extractTranscript(metadata, 1000)).rejects.toThrow(TranscriptParseError);
  });

  it("rejects decompression bombs at the duration-scaled cap", async () => {
    // ~40MB of zeros compresses to ~40KB; a 1-second book caps around 1MB.
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const metadata = metadataWithGeob(geobFrame(new Uint8Array(bomb)));
    await expect(extractTranscript(metadata, 1000)).rejects.toThrow(/exceeds the cap/);
  });

  it("rejects oversized compressed frames without inflating them", async () => {
    const oversized = { ...geobFrame(new Uint8Array(1)), data: { byteLength: 25 * 1024 * 1024 } };
    const metadata = metadataWithGeob(oversized as unknown as Record<string, unknown>);
    await expect(extractTranscript(metadata, 1000)).rejects.toThrow(/compressed frame/);
  });
});
