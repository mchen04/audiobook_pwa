import type { IAudioMetadata } from "music-metadata";

export type ParsedChapter = {
  position: number;
  title: string;
  startMs: number;
  endMs: number;
};

export type ParsedArtwork = {
  data: Uint8Array;
  extension: "jpg" | "png" | "webp";
  mimeType: string;
};

export type ParsedMp3 = {
  title: string;
  author: string;
  narrator: string | null;
  durationMs: number;
  chapters: ParsedChapter[];
  chapterDiagnostic: string | null;
  artwork: ParsedArtwork | null;
};

const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;

export class InvalidMp3Error extends Error {
  constructor(message = "The selected file is not a valid MP3.") {
    super(message);
    this.name = "InvalidMp3Error";
  }
}

/**
 * Pure interpretation of a parsed MP3: format validation, metadata cleanup,
 * chapter normalization, artwork sniffing. Shared by the server import parser
 * and the in-browser parser for device-local books.
 *
 * `fallbackDurationMs` covers files whose duration the tag parse cannot see
 * cheaply (VBR without a Xing header) — a full frame scan of a multi-gigabyte
 * audiobook is not viable in the browser, so the caller probes the duration
 * through the platform's audio decoder instead.
 */
export function interpretMp3Metadata(
  metadata: IAudioMetadata,
  fallbackTitle: string,
  fallbackDurationMs?: number,
): ParsedMp3 {
  const durationSeconds = metadata.format.duration || (fallbackDurationMs ?? 0) / 1000;
  if (
    !metadata.format.hasAudio ||
    metadata.format.hasVideo ||
    metadata.format.container !== "MPEG" ||
    !metadata.format.codec?.includes("Layer 3") ||
    !durationSeconds ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new InvalidMp3Error();
  }

  const durationMs = Math.round(durationSeconds * 1000);
  const title = cleanText(metadata.common.title || fallbackTitle, 300) || "Untitled audiobook";
  const author = cleanText(metadata.common.artist || "Unknown author", 240) || "Unknown author";
  const composer = metadata.common.composer;
  const narrator =
    cleanText(Array.isArray(composer) ? composer[0] || "" : composer || "", 240) || null;
  const rawChapters = metadata.format.chapters || [];
  const chapters = normalizeChapters(rawChapters, durationMs);
  const artwork = extractArtwork(metadata.common.picture);

  if (!chapters) {
    return {
      title,
      author,
      narrator,
      durationMs,
      chapters: [{ position: 0, title: "Full audiobook", startMs: 0, endMs: durationMs }],
      chapterDiagnostic:
        rawChapters.length === 0
          ? "No embedded chapters were found. The MP3 is available as one chapter."
          : "Embedded chapter data was malformed. The MP3 is available as one chapter.",
      artwork,
    };
  }

  return { title, author, narrator, durationMs, chapters, chapterDiagnostic: null, artwork };
}

// Embedded artwork is only trusted when its actual bytes match a known raster
// signature; declared MIME alone is not enough.
export function extractArtwork(
  pictures: Array<{ format?: string; data: Uint8Array }> | undefined,
): ParsedArtwork | null {
  const picture = pictures?.[0];
  if (!picture || picture.data.length === 0 || picture.data.length > MAX_ARTWORK_BYTES) return null;

  const bytes = picture.data;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { data: bytes, extension: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { data: bytes, extension: "png", mimeType: "image/png" };
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { data: bytes, extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

function normalizeChapters(
  rawChapters: NonNullable<IAudioMetadata["format"]["chapters"]>,
  durationMs: number,
): ParsedChapter[] | null {
  if (rawChapters.length === 0) return null;

  const normalized = rawChapters.map((chapter, position) => ({
    position,
    title: cleanText(chapter.title || `Chapter ${position + 1}`, 500) || `Chapter ${position + 1}`,
    startMs: Math.round(chapter.start * 1000),
    endMs: chapter.end === undefined ? Number.NaN : Math.round(chapter.end * 1000),
  }));

  for (let index = 0; index < normalized.length; index += 1) {
    const chapter = normalized[index]!;
    const previous = normalized[index - 1];
    if (
      !Number.isFinite(chapter.startMs) ||
      !Number.isFinite(chapter.endMs) ||
      chapter.startMs < 0 ||
      chapter.endMs <= chapter.startMs ||
      chapter.endMs > durationMs + 1500 ||
      (previous && chapter.startMs < previous.endMs)
    ) {
      return null;
    }

    chapter.endMs = Math.min(chapter.endMs, durationMs);
  }

  return normalized;
}

/**
 * Validates an already-normalized chapter list: contiguous positions from 0,
 * sane bounds, no overlap, and every chapter inside the book's duration. The
 * registration endpoint re-checks client-parsed chapters with this before
 * trusting them into the database.
 */
export function isValidChapterSequence(chapterList: ParsedChapter[], durationMs: number): boolean {
  if (chapterList.length === 0) return false;
  for (let index = 0; index < chapterList.length; index += 1) {
    const chapter = chapterList[index]!;
    const previous = chapterList[index - 1];
    if (
      chapter.position !== index ||
      !Number.isInteger(chapter.startMs) ||
      !Number.isInteger(chapter.endMs) ||
      chapter.startMs < 0 ||
      chapter.endMs <= chapter.startMs ||
      chapter.endMs > durationMs ||
      (previous && chapter.startMs < previous.endMs)
    ) {
      return false;
    }
  }
  return true;
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
