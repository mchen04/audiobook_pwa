import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { parseFile } from "music-metadata";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  interpretMp3Metadata,
  InvalidMp3Error,
  isValidChapterSequence,
  reconcileChapterSequenceDuration,
  shouldReplaceChapterSequence,
  type ParsedMp3,
} from "./mp3";

const testRoots: string[] = [];

beforeAll(() => {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("FFmpeg is required for MP3 contract tests.");
});

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(chaptered: boolean): Promise<string> {
  const root = `.data/tests/metadata-${crypto.randomUUID()}`;
  testRoots.push(root);
  await mkdir(root, { recursive: true });
  const source = `${root}/source.mp3`;
  const metadata = `${root}/ffmetadata.txt`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
  ];

  if (chaptered) {
    await writeFile(
      metadata,
      ";FFMETADATA1\ntitle=Fixture Book\nartist=Fixture Author\nalbum=Fixture Book\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Second Chapter\n",
    );
    args.push("-i", metadata, "-map_metadata", "1");
  }
  args.push("-c:a", "libmp3lame", "-q:a", "5", "-id3v2_version", "3", source);

  const generated = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr);
  return source;
}

async function overflowingChapterFixture(untitledIndex?: number): Promise<string> {
  const chapterCount = 486;
  const chapterDurationMs = 10;
  const root = `.data/tests/chapter-overflow-${crypto.randomUUID()}`;
  testRoots.push(root);
  await mkdir(root, { recursive: true });
  const source = `${root}/source.mp3`;
  const metadata = `${root}/ffmetadata.txt`;
  const chapterMetadata = Array.from({ length: chapterCount }, (_, index) => {
    const title = index === untitledIndex ? "" : `title=Chapter ${index + 1}\n`;
    return `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${index * chapterDurationMs}\nEND=${(index + 1) * chapterDurationMs}\n${title}`;
  }).join("");
  await writeFile(metadata, `;FFMETADATA1\ntitle=Overflow Book\n${chapterMetadata}`);

  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${(chapterCount * chapterDurationMs) / 1_000}`,
      "-i",
      metadata,
      "-map_metadata",
      "1",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "5",
      "-id3v2_version",
      "3",
      source,
    ],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  return source;
}

// Mirrors the browser importer: parse failures and format mismatches are both
// InvalidMp3Error.
async function parseFixture(filePath: string, fallbackTitle: string): Promise<ParsedMp3> {
  let metadata;
  try {
    metadata = await parseFile(filePath, { duration: true, skipCovers: false });
  } catch {
    throw new InvalidMp3Error();
  }
  return interpretMp3Metadata(metadata, fallbackTitle);
}

describe("interpretMp3Metadata", () => {
  it("reads the exact chapter format emitted by Epub Listener's FFmpeg flow", async () => {
    const parsed = await parseFixture(await fixture(true), "source");

    expect(parsed.title).toBe("Fixture Book");
    expect(parsed.author).toBe("Fixture Author");
    expect(parsed.durationMs).toBeGreaterThanOrEqual(2_000);
    expect(parsed.chapterDiagnostic).toBeNull();
    expect(parsed.chapters).toEqual([
      { position: 0, title: "Opening", startMs: 0, endMs: 1_000 },
      { position: 1, title: "Second Chapter", startMs: 1_000, endMs: 2_000 },
    ]);
  });

  it("recovers every native chapter when the ID3 table-of-contents count wraps", async () => {
    const parsed = await parseFixture(await overflowingChapterFixture(), "source");

    expect(parsed.chapterDiagnostic).toBeNull();
    expect(parsed.chapters).toHaveLength(486);
    expect(parsed.chapters[229]?.title).toBe("Chapter 230");
    expect(parsed.chapters[485]).toEqual({
      position: 485,
      title: "Chapter 486",
      startMs: 4_850,
      endMs: 4_860,
    });
  });

  it("retains untitled native chapters when recovering an overflowed table of contents", async () => {
    const parsed = await parseFixture(await overflowingChapterFixture(255), "source");

    expect(parsed.chapters).toHaveLength(486);
    expect(parsed.chapters[255]?.title).toBe("Chapter 256");
  });

  it("falls back to valid generic chapters when a larger native sequence is malformed", async () => {
    const metadata = await parseFile(await fixture(true), { duration: true });
    metadata.native["ID3v2.3"]?.push({
      id: "CHAP",
      value: {
        label: "orphan",
        info: { startTime: 500, endTime: 3_000 },
        frames: new Map([["TIT2", "Orphan"]]),
      },
    });

    const parsed = interpretMp3Metadata(metadata, "source");

    expect(parsed.chapters).toEqual([
      { position: 0, title: "Opening", startMs: 0, endMs: 1_000 },
      { position: 1, title: "Second Chapter", startMs: 1_000, endMs: 2_000 },
    ]);
  });

  it("does not accept embedded chapters that leave most of the audiobook uncovered", async () => {
    const metadata = await parseFile(await fixture(true), { duration: true });
    const parsed = interpretMp3Metadata(
      { ...metadata, format: { ...metadata.format, duration: 10 } },
      "source",
    );

    expect(parsed.chapters).toEqual([
      { position: 0, title: "Full audiobook", startMs: 0, endMs: 10_000 },
    ]);
    expect(parsed.chapterDiagnostic).toMatch("malformed");
  });

  it("falls back to the album artist when the artist tag is absent", async () => {
    const root = `.data/tests/albumartist-${crypto.randomUUID()}`;
    testRoots.push(root);
    await mkdir(root, { recursive: true });
    const source = `${root}/source.mp3`;
    const generated = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-metadata",
        "album_artist=Band Artist Only",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "5",
        "-id3v2_version",
        "3",
        source,
      ],
      { encoding: "utf8" },
    );
    if (generated.status !== 0) throw new Error(generated.stderr);

    const parsed = await parseFixture(source, "source");
    expect(parsed.author).toBe("Band Artist Only");
  });

  it("falls back to the album name when the title tag is absent", async () => {
    const root = `.data/tests/albumtitle-${crypto.randomUUID()}`;
    testRoots.push(root);
    await mkdir(root, { recursive: true });
    const source = `${root}/source.mp3`;
    const generated = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-metadata",
        "album=Book Name From Album",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "5",
        "-id3v2_version",
        "3",
        source,
      ],
      { encoding: "utf8" },
    );
    if (generated.status !== 0) throw new Error(generated.stderr);

    const parsed = await parseFixture(source, "source");
    expect(parsed.title).toBe("Book Name From Album");
  });

  it("skips blank title and artist tags when choosing metadata fallbacks", async () => {
    const metadata = await parseFile(await fixture(false), { duration: true });
    metadata.common.title = " \u0000 ";
    metadata.common.album = "Book Name From Album";
    metadata.common.artist = "\t";
    metadata.common.albumartist = "Author From Album";

    const parsed = interpretMp3Metadata(metadata, "Filename Fallback");

    expect(parsed.title).toBe("Book Name From Album");
    expect(parsed.author).toBe("Author From Album");
  });

  it("always supplies a nonempty title when every title source is blank", async () => {
    const metadata = await parseFile(await fixture(false), { duration: true });
    metadata.common.title = "\t";
    metadata.common.album = " \u0000 ";

    expect(interpretMp3Metadata(metadata, "").title).toBe("Untitled audiobook");
  });

  it("falls back to one explicit chapter for a valid chapterless MP3", async () => {
    const parsed = await parseFixture(await fixture(false), "Plain Book");

    expect(parsed.title).toBe("Plain Book");
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0]?.title).toBe("Full audiobook");
    expect(parsed.chapterDiagnostic).toMatch("No embedded chapters");
  });

  it("rejects a disguised non-MP3", async () => {
    const root = `.data/tests/invalid-${crypto.randomUUID()}`;
    testRoots.push(root);
    await mkdir(root, { recursive: true });
    const fake = `${root}/disguised.mp3`;
    await writeFile(fake, "this is not audio at all, just text pretending");

    await expect(parseFixture(fake, "disguised")).rejects.toBeInstanceOf(InvalidMp3Error);
  });
});

describe("chapter sequence validation", () => {
  const complete = [
    { position: 0, title: "One", startMs: 0, endMs: 5_000 },
    { position: 1, title: "Two", startMs: 5_000, endMs: 10_000 },
  ];
  const truncated = [{ position: 0, title: "One", startMs: 0, endMs: 5_000 }];

  it("requires the final chapter to reach the end of the audiobook", () => {
    expect(isValidChapterSequence(complete, 10_000)).toBe(true);
    expect(isValidChapterSequence(truncated, 10_000)).toBe(false);
  });

  it("repairs only an incomplete sequence with a complete candidate", () => {
    expect(shouldReplaceChapterSequence(truncated, complete, 10_000)).toBe(true);
    expect(shouldReplaceChapterSequence(complete, complete, 10_000)).toBe(false);
    expect(
      shouldReplaceChapterSequence(
        truncated,
        [complete[0]!, { ...complete[1]!, endMs: 10_001 }],
        10_000,
      ),
    ).toBe(false);
  });

  it("reconciles small duration drift and rejects material mismatches", () => {
    const oneMillisecondLong = [complete[0]!, { ...complete[1]!, endMs: 10_001 }];

    expect(reconcileChapterSequenceDuration(oneMillisecondLong, 10_001, 10_000)).toEqual(complete);
    expect(reconcileChapterSequenceDuration(complete, 12_000, 10_000)).toBeNull();
  });
});
