import { createSHA256 } from "hash-wasm";

export type MediaFingerprintKind = "sample-v1" | "sha256-v1";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const SAMPLE_BYTES = 1024 * 1024;

export async function fingerprintMedia(
  file: File,
  kind: MediaFingerprintKind,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return kind === "sample-v1" ? sampleFingerprint(file) : fullSha256(file, onProgress);
}

async function fullSha256(file: File, onProgress?: (fraction: number) => void) {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    const chunk = new Uint8Array(
      await file.slice(offset, Math.min(file.size, offset + HASH_CHUNK_BYTES)).arrayBuffer(),
    );
    hasher.update(chunk);
    onProgress?.(Math.min(1, (offset + chunk.byteLength) / file.size));
  }
  onProgress?.(1);
  return hasher.digest();
}

async function sampleFingerprint(file: File) {
  const head = await file.slice(0, SAMPLE_BYTES).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - SAMPLE_BYTES)).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const combined = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  combined.set(sizeBytes, 0);
  combined.set(new Uint8Array(head), sizeBytes.length);
  combined.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
