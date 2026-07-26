import { interpretMp3Metadata, InvalidMp3Error, type ParsedMp3 } from "@/domain/mp3";
import type { PlayerBook, PlayerChapter } from "@/domain/player";
import type { BookTranscript } from "@/domain/transcript";
import { fingerprintMedia } from "@/lib/media-fingerprint";
import { storeLocalBookMedia, withLocalMediaSlot } from "@/lib/offline/media-store";
import { commitImport } from "@/lib/offline/outbox";
import { storeBookTranscript } from "@/lib/offline/transcript-store";
import { getDeviceId } from "@/lib/playback-core";
import { extractTranscript } from "@/lib/transcript-import";

export type ParsedLocalMp3 = ParsedMp3 & {
  /** Read-along cues embedded by the generator, if present and valid. */
  transcript: BookTranscript | null;
  /** Why a present transcript was dropped; audio import is unaffected. */
  transcriptDiagnostic: string | null;
};

/** Parses an MP3 entirely in the browser; the bytes never leave the device. */
export async function parseLocalMp3(file: File): Promise<ParsedLocalMp3> {
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
  const parsed = interpretMp3Metadata(metadata, fallbackTitle, fallbackDurationMs);
  let transcript: BookTranscript | null = null;
  let transcriptDiagnostic: string | null = null;
  try {
    transcript = await extractTranscript(metadata, parsed.durationMs);
  } catch (error) {
    transcriptDiagnostic = error instanceof Error ? error.message : "Transcript rejected.";
    console.warn(`Read-along transcript dropped for "${file.name}": ${transcriptDiagnostic}`);
  }
  return { ...parsed, transcript, transcriptDiagnostic };
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
 * The whole import: parse locally, journal the registration, tell the server
 * about it if the server is reachable, then store the audio bytes on this
 * device. No audio ever uploads, so file size is bounded only by this device's
 * storage — and nothing on this path ever sends the file's contents anywhere.
 *
 * The registration is journalled in the outbox *before* the network is touched,
 * which is what makes an import done on a plane a book rather than a lost
 * afternoon. Two consequences follow from that ordering:
 *
 * - The book id is minted here, by this device, and travels in the queued
 *   registration. The MP3 has to be keyed under *something* the moment it is
 *   written, and waiting for the server to name it would mean either blocking
 *   the import on a round trip or filing the audio under a name the eventual
 *   row does not share. The route treats a registration that names an id it
 *   already holds as settled, so a replay is a no-op rather than a second book.
 *   When the registration replays into a 409 instead — the fingerprint already
 *   belongs to another book — the outbox moves this device's copy onto that id
 *   (`offline/library.ts#reattachLocalBookIdentity`). Everything written under
 *   the minted id therefore happens inside ONE media slot, so that move can
 *   only ever run before it starts or after it has finished, never through the
 *   middle of it.
 * - The direct POST below is an optimization, not the write. It exists so an
 *   online import is visible to the account's other devices immediately, and so
 *   the 409 duplicate answer can reattach these bytes to the book that already
 *   owns this fingerprint. When it cannot happen, the queued row still lands.
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

  const registration = {
    bookId: crypto.randomUUID(),
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
  };
  await withLocalMediaSlot(userId, registration.bookId, async (slot) => {
    await commitImport({ userId, deviceId: getDeviceId() }, fingerprint, registration);

    const response = await fetch("/api/books/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    }).catch(() => null);
    let bookId = registration.bookId;
    let canonicalBook: Omit<PlayerBook, "mediaUrl" | "coverUrl"> | null = null;
    if (response?.ok) {
      ({ bookId } = (await response.json()) as { bookId: string });
    } else if (response) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        existingBookId?: string;
        playerBook?: Omit<PlayerBook, "mediaUrl" | "coverUrl">;
      } | null;
      // A fingerprint match means this exact file already has a book — most
      // often one whose audio is missing on this device. Reattach the bytes to
      // that book instead of dead-ending on "already in your library". The queued
      // row replays into the same 409 and settles without creating anything.
      if (response.status === 409 && payload?.existingBookId) {
        bookId = payload.existingBookId;
        canonicalBook = payload.playerBook || null;
      } else {
        throw new Error(payload?.error || "The MP3 could not be imported.");
      }
    }
    // `response` is null only when the network could not be reached at all. The
    // registration is already durable, so the import continues under the id this
    // device minted and the server is told on the next drain.
    // Copying a multi-gigabyte file into device storage is the long tail of the
    // import; the percent tracks stored chunks so the wait visibly moves.
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
        (fraction) =>
          onProgress(Math.min(99, 70 + Math.round(fraction * 29)), "Saving to this device"),
        // The slot names the minted id; a reattach that sent these bytes to the
        // canonical id instead takes its own lock for that one.
        slot,
      );
    } catch (error) {
      // Registration is already visible to other tabs and devices. Keep the
      // recoverable metadata row rather than deleting a book another tab may
      // have attached successfully; choosing the same MP3 repairs local media.
      const reason = error instanceof Error ? error.message : "The audiobook could not be saved.";
      throw new Error(`${reason} Choose the same MP3 again to finish saving it on this device.`);
    }
    if (parsed.transcript) {
      // Device-only: cues live beside the audio and never reach the server. A
      // failed cue write is not worth failing an import the audio survived.
      try {
        await storeBookTranscript(userId, bookId, parsed.transcript);
      } catch {
        console.warn("Read-along cues could not be saved; the book plays without them.");
      }
    }
  });
  onProgress(100, "Finishing");
}
