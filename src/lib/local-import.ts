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
    metadata = await parseBlob(file, { duration: true, skipCovers: false });
  } catch {
    throw new InvalidMp3Error();
  }
  const fallbackTitle = file.name.replace(/\.[^.]*$/, "");
  return interpretMp3Metadata(metadata, fallbackTitle);
}

/**
 * The whole import: parse locally, register metadata with the server, then
 * store the audio bytes on this device. No audio ever uploads, so file size
 * is bounded only by this device's storage.
 */
export async function importLocalMp3(
  userId: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  onProgress(5);
  const parsed = await parseLocalMp3(file);
  onProgress(45);
  const fingerprint = await fileFingerprint(file);
  onProgress(55);

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
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || "The MP3 could not be imported.");
  }
  const { bookId } = (await response.json()) as { bookId: string };
  onProgress(70);

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
    // Without local bytes the registration is an empty shell — undo it.
    void fetch(`/api/books/${bookId}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
  onProgress(100);
}
