const THUMB_LONGEST_EDGE = 256;

/**
 * Downscales embedded cover art (accepted up to 5MB) once at import so the
 * library grid, mini player, and downloads list never decode a multi-megabyte
 * image to paint a thumbnail. Returns null when the source is already small
 * or the platform lacks OffscreenCanvas — callers fall back to the original.
 */
export async function createCoverThumbnail(
  data: Uint8Array,
  mimeType: string,
): Promise<{ data: Blob; mimeType: string } | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(data)], { type: mimeType }));
    const scale = THUMB_LONGEST_EDGE / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) {
      bitmap.close();
      return null;
    }
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    return { data: blob, mimeType: blob.type };
  } catch {
    return null;
  }
}
