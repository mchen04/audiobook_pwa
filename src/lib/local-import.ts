import { interpretMp3Metadata, InvalidMp3Error, type ParsedMp3 } from "@/domain/mp3";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import { fingerprintMedia } from "@/lib/media-fingerprint";
import { storeLocalBookMedia } from "@/lib/offline/media-store";

/** Parses an MP3 entirely in the browser; the bytes never leave the device. */
export async function parseLocalMp3(file: File): Promise<ParsedMp3> {
  const { parseBlob } = await import("music-metadata");
  let metadata;
  try {
    // duration:true would scan every frame when a VBR file lacks a Xing
    // header — minutes of reading on a multi-gigabyte audiobook. Parse tags
    // only; when the duration is not cheaply known, the audio decoder below
    // estimates it instantly instead.
    metadata = await parseBlob(file, { duration: false, skipCovers: false });
  } catch {
    throw new InvalidMp3Error();
  }
  const fallbackTitle = file.name.replace(/\.[^.]*$/, "");
  const parsedDuration = metadata.format.duration;
  const fallbackDurationMs =
    parsedDuration && Number.isFinite(parsedDuration) && parsedDuration > 0
      ? undefined
      : await probeAudioDurationMs(file);
  return interpretMp3Metadata(metadata, fallbackTitle, fallbackDurationMs);
}

/**
 * Reads a file's duration through the platform decoder. Browsers estimate an
 * MP3's length from its bitrate and byte size without reading the whole file,
 * which is the only workable option for huge VBR files without Xing headers.
 */
function probeAudioDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      clearTimeout(timer);
    };
    const fail = () => {
      cleanup();
      reject(new InvalidMp3Error());
    };
    const timer = setTimeout(fail, 30_000);
    audio.addEventListener("loadedmetadata", () => {
      const seconds = audio.duration;
      cleanup();
      if (Number.isFinite(seconds) && seconds > 0) resolve(Math.round(seconds * 1000));
      else reject(new InvalidMp3Error());
    });
    audio.addEventListener("error", fail);
    audio.preload = "metadata";
    audio.src = url;
  });
}

/**
 * The whole import: parse locally, register metadata with the server, then
 * store the audio bytes on this device. No audio ever uploads, so file size
 * is bounded only by this device's storage.
 */
export async function importLocalMp3(
  userId: string,
  file: File,
  onProgress: (percent: number, stage: string) => void,
): Promise<void> {
  onProgress(5, "Reading metadata");
  const parsed = await parseLocalMp3(file);
  onProgress(45, "Checking the complete file");
  const fingerprintKind = "sha256-v1" as const;
  const fingerprint = await fingerprintMedia(file, fingerprintKind, (fraction) =>
    onProgress(45 + Math.round(fraction * 10), "Checking the complete file"),
  );
  onProgress(55, "Adding to your library");

  const response = await fetch("/api/books/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: encodeURIComponent(file.name),
      byteSize: file.size,
      durationMs: parsed.durationMs,
      fingerprint,
      fingerprintKind,
      title: parsed.title,
      author: parsed.author,
      narrator: parsed.narrator,
      chapterDiagnostic: parsed.chapterDiagnostic,
      chapters: parsed.chapters,
    }),
  }).catch(() => {
    throw new Error("The book could not be registered. Check your connection.");
  });
  let bookId: string;
  let canonicalBook: Omit<PlayerBook, "mediaUrl" | "coverUrl"> | null = null;
  if (response.ok) {
    ({ bookId } = (await response.json()) as { bookId: string });
  } else {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      existingBookId?: string;
      playerBook?: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
    } | null;
    // A fingerprint match means this exact file already has a book — most
    // often one whose audio is missing on this device. Reattach the bytes to
    // that book instead of dead-ending on "already in your library".
    if (response.status === 409 && payload?.existingBookId) {
      bookId = payload.existingBookId;
      canonicalBook = payload.playerBook || null;
    } else {
      throw new Error(payload?.error || "The MP3 could not be imported.");
    }
  }
  // Copying a multi-gigabyte file into device storage is the long tail of the
  // import; the stage label keeps the wait legible while the percent holds.
  onProgress(70, "Saving to this device");

  const chapters: PlayerChapter[] = parsed.chapters.map((chapter) => ({
    id: `${bookId}:${chapter.position}`,
    ...chapter,
  }));
  try {
    await storeLocalBookMedia(
      userId,
      canonicalBook || {
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        durationMs: parsed.durationMs,
        chapters,
        initialPositionMs: 0,
        initialProgressOccurredAt: null,
        initialPlaybackRate: 1,
        completed: false,
      },
      file,
      parsed.artwork ? { data: parsed.artwork.data, mimeType: parsed.artwork.mimeType } : null,
    );
  } catch (error) {
    // Registration is already visible to other tabs and devices. Keep the
    // recoverable metadata row rather than deleting a book another tab may
    // have attached successfully; choosing the same MP3 repairs local media.
    const reason = error instanceof Error ? error.message : "The audiobook could not be saved.";
    throw new Error(`${reason} Choose the same MP3 again to finish saving it on this device.`);
  }
  onProgress(100, "Finishing");
}
