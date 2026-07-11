import { interpretMp3Metadata, InvalidMp3Error, type ParsedMp3 } from "@/domain/mp3";
import type { PlayerChapter } from "@/domain/player";
import { storeLocalBookMedia } from "@/lib/offline-library";

const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;

/**
 * A cheap, stable identity for a media file: SHA-256 over the byte count plus
 * the first and last megabyte. Hashing whole multi-gigabyte audiobooks in the
 * browser is not practical; this is a dedup aid, not a security boundary.
 */
export async function fileFingerprint(file: File): Promise<string> {
  const head = await file.slice(0, FINGERPRINT_SAMPLE_BYTES).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - FINGERPRINT_SAMPLE_BYTES)).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const combined = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  combined.set(sizeBytes, 0);
  combined.set(new Uint8Array(head), sizeBytes.length);
  combined.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  onProgress(5, "Reading chapters");
  const parsed = await parseLocalMp3(file);
  onProgress(45, "Reading chapters");
  const fingerprint = await fileFingerprint(file);
  onProgress(55, "Adding to your library");

  const response = await fetch("/api/books/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: encodeURIComponent(file.name),
      byteSize: file.size,
      durationMs: parsed.durationMs,
      fingerprint,
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
  let createdNewBook = true;
  if (response.ok) {
    ({ bookId } = (await response.json()) as { bookId: string });
  } else {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      existingBookId?: string;
    } | null;
    // A fingerprint match means this exact file already has a book — most
    // often one whose audio is missing on this device. Reattach the bytes to
    // that book instead of dead-ending on "already in your library".
    if (response.status === 409 && payload?.existingBookId) {
      bookId = payload.existingBookId;
      createdNewBook = false;
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
      {
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        durationMs: parsed.durationMs,
        chapters,
        initialPositionMs: 0,
        initialPlaybackRate: 1,
        completed: false,
      },
      file,
      parsed.artwork ? { data: parsed.artwork.data, mimeType: parsed.artwork.mimeType } : null,
    );
  } catch (error) {
    // Without local bytes a fresh registration is an empty shell — undo it.
    // A pre-existing book keeps its progress and bookmarks and stays put.
    if (createdNewBook) {
      void fetch(`/api/books/${bookId}`, { method: "DELETE" }).catch(() => undefined);
    }
    throw error;
  }
  onProgress(100, "Finishing");
}
