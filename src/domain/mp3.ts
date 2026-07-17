import type { IAudioMetadata, IChapter } from "music-metadata";

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
const CHAPTER_BOUNDARY_TOLERANCE_MS = 1_500;

type NativeChapterFrame = {
  label: string;
  info: { startTime: number; endTime: number };
  frames: Map<string, unknown>;
};

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
  const title =
    firstCleanText([metadata.common.title, metadata.common.album, fallbackTitle], 300) ||
    "Untitled audiobook";
  // Audiobooks frequently carry the author in TPE2 (album artist) instead of
  // TPE1, so both are honored before giving up.
  const author =
    firstCleanText([metadata.common.artist, metadata.common.albumartist], 240) || "Unknown author";
  const composer = metadata.common.composer;
  const narrator =
    cleanText(Array.isArray(composer) ? composer[0] || "" : composer || "", 240) || null;
  const formatChapters = metadata.format.chapters || [];
  const nativeChapters = extractNativeId3Chapters(metadata);
  const normalizedFormatChapters = normalizeChapters(formatChapters, durationMs);
  const normalizedNativeChapters = normalizeChapters(nativeChapters, durationMs);
  const chapters =
    normalizedNativeChapters &&
    normalizedNativeChapters.length > (normalizedFormatChapters?.length || 0)
      ? normalizedNativeChapters
      : normalizedFormatChapters;
  const hasEmbeddedChapters = formatChapters.length > 0 || nativeChapters.length > 0;
  const artwork = extractArtwork(metadata.common.picture);

  if (!chapters) {
    return {
      title,
      author,
      narrator,
      durationMs,
      chapters: [{ position: 0, title: "Full audiobook", startMs: 0, endMs: durationMs }],
      chapterDiagnostic: !hasEmbeddedChapters
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
      chapter.endMs > durationMs + CHAPTER_BOUNDARY_TOLERANCE_MS ||
      (previous && chapter.startMs < previous.endMs)
    ) {
      return null;
    }

    chapter.endMs = Math.min(chapter.endMs, durationMs);
  }

  if (!chapterSequenceCoversDuration(normalized, durationMs)) return null;

  return normalized;
}

function extractNativeId3Chapters(metadata: IAudioMetadata): IChapter[] {
  let largest: IChapter[] = [];

  for (const [tagType, tags] of Object.entries(metadata.native)) {
    if (!tagType.startsWith("ID3v2.")) continue;
    const nativeChapters = tags.flatMap((tag) => {
      if (tag.id !== "CHAP" || !isNativeChapterFrame(tag.value)) return [];
      const title = tag.value.frames.get("TIT2");
      return [
        {
          id: tag.value.label,
          title: typeof title === "string" ? title : "",
          start: tag.value.info.startTime / 1_000,
          end: tag.value.info.endTime / 1_000,
        },
      ];
    });
    if (nativeChapters.length > largest.length) largest = nativeChapters;
  }

  return largest.sort((left, right) => left.start - right.start);
}

function isNativeChapterFrame(value: unknown): value is NativeChapterFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<NativeChapterFrame>;
  return (
    typeof frame.label === "string" &&
    typeof frame.info?.startTime === "number" &&
    typeof frame.info.endTime === "number" &&
    frame.frames instanceof Map
  );
}

function chapterSequenceCoversDuration(
  chapterList: Array<Pick<ParsedChapter, "startMs" | "endMs">>,
  durationMs: number,
): boolean {
  const first = chapterList[0];
  const last = chapterList[chapterList.length - 1];
  return Boolean(
    first &&
    last &&
    first.startMs <= CHAPTER_BOUNDARY_TOLERANCE_MS &&
    last.endMs >= durationMs - CHAPTER_BOUNDARY_TOLERANCE_MS,
  );
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
  return chapterSequenceCoversDuration(chapterList, durationMs);
}

export function shouldReplaceChapterSequence(
  current: ParsedChapter[],
  candidate: ParsedChapter[],
  durationMs: number,
): boolean {
  return (
    !isValidChapterSequence(current, durationMs) && isValidChapterSequence(candidate, durationMs)
  );
}

export function reconcileChapterSequenceDuration(
  candidate: ParsedChapter[],
  candidateDurationMs: number,
  canonicalDurationMs: number,
): ParsedChapter[] | null {
  if (
    Math.abs(candidateDurationMs - canonicalDurationMs) > CHAPTER_BOUNDARY_TOLERANCE_MS ||
    candidate.length === 0
  ) {
    return null;
  }

  const reconciled = candidate.map((chapter, index) =>
    index === candidate.length - 1 ? { ...chapter, endMs: canonicalDurationMs } : chapter,
  );
  return isValidChapterSequence(reconciled, canonicalDurationMs) ? reconciled : null;
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function firstCleanText(values: Array<string | undefined>, maxLength: number): string {
  for (const value of values) {
    if (!value) continue;
    const cleaned = cleanText(value, maxLength);
    if (cleaned) return cleaned;
  }
  return "";
}
