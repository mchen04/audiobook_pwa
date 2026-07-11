import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { parseFile } from "music-metadata";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { interpretMp3Metadata, InvalidMp3Error, type ParsedMp3 } from "./mp3";

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
