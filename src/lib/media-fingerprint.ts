import type { FingerprintWorkerResponse } from "./media-hash";

export type MediaFingerprintKind = "sample-v1" | "sha256-v1";

const SAMPLE_BYTES = 1024 * 1024;

export async function fingerprintMedia(
  file: File,
  kind: MediaFingerprintKind,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  if (kind === "sample-v1") return sampleFingerprint(file);
  // Hashing a whole audiobook is heavy CPU; run it off the main thread so
  // import and playback stay responsive. Worker-less environments (tests)
  // hash inline via the same shared routine.
  if (typeof Worker !== "undefined") return workerSha256(file, onProgress);
  const { fullSha256 } = await import("./media-hash");
  return fullSha256(file, onProgress);
}

function workerSha256(file: File, onProgress?: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./media-fingerprint.worker.ts", import.meta.url));
    const settle = (complete: () => void) => {
      worker.terminate();
      complete();
    };
    worker.onmessage = (event: MessageEvent<FingerprintWorkerResponse>) => {
      const response = event.data;
      if (response.type === "progress") onProgress?.(response.fraction);
      else if (response.type === "done") settle(() => resolve(response.digest));
      else settle(() => reject(new Error(response.message)));
    };
    worker.onerror = () => settle(() => reject(new Error("The file could not be fingerprinted.")));
    worker.postMessage(file);
  });
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
