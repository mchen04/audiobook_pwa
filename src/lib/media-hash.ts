import { createSHA256 } from "hash-wasm";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type FingerprintWorkerResponse =
  | { type: "progress"; fraction: number }
  | { type: "done"; digest: string }
  | { type: "error"; message: string };

export async function fullSha256(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
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
