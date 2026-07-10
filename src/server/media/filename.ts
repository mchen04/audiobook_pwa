const acceptedMimeTypes = new Set(["audio/mpeg", "audio/mp3", "application/octet-stream"]);

export function validateUploadMetadata(filename: string, mimeType: string): string {
  const decoded = decodeFilename(filename);
  if (!decoded.toLowerCase().endsWith(".mp3")) {
    throw new Error("Choose an MP3 file. Other audiobook formats are not supported.");
  }
  if (!acceptedMimeTypes.has(mimeType.toLowerCase())) {
    throw new Error("The selected file does not use an accepted MP3 content type.");
  }
  if (decoded.length > 512) throw new Error("The MP3 filename is too long.");
  return decoded;
}

function decodeFilename(value: string): string {
  try {
    const decoded = decodeURIComponent(value).replaceAll("\\", "/").split("/").at(-1)?.trim();
    if (!decoded || decoded === "." || decoded === "..") throw new Error();
    return decoded;
  } catch {
    throw new Error("The MP3 filename is invalid.");
  }
}
