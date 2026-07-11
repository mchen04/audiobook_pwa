import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const mediaCache = source.match(/const MEDIA_CACHE[^;]+;/)?.[0];
const functions = source.match(
  /async function serveOfflineMedia[\s\S]*?(?=\nfunction parseRange)/,
)?.[0];
const parseRange = source.match(/function parseRange[\s\S]*$/)?.[0];

if (!mediaCache || !functions || !parseRange) {
  throw new Error("Service-worker media helpers missing");
}

const createServeOfflineMedia = new Function(
  "caches",
  `${mediaCache}\n${functions}\n${parseRange}\nreturn serveOfflineMedia;`,
) as (cacheStorage: CacheStorage) => (request: Request, pathname: string) => Promise<Response>;

describe("service-worker chunked media", () => {
  it("streams an open-ended media request from its individual chunks", async () => {
    const mediaUrl = "/offline-media/book";
    const chunkSize = 2 * 1024 * 1024;
    const entries = new Map<string, Response>([
      [
        mediaUrl,
        new Response(
          JSON.stringify({
            format: "chapterline-chunked-media-v1",
            byteSize: chunkSize * 3,
            chunkSize,
            chunkCount: 3,
          }),
          { headers: { "X-Chapterline-Media-Format": "chunked-v1" } },
        ),
      ],
      [`${mediaUrl}/chunk/0`, new Response(new Uint8Array(chunkSize).fill(1))],
      [`${mediaUrl}/chunk/1`, new Response(new Uint8Array(chunkSize).fill(2))],
      [`${mediaUrl}/chunk/2`, new Response(new Uint8Array(chunkSize).fill(3))],
    ]);
    const match = vi.fn(async (url: string) => entries.get(url)?.clone());
    const serveOfflineMedia = createServeOfflineMedia({
      open: vi.fn(async () => ({ match })) as never,
    } as unknown as CacheStorage);

    const response = await serveOfflineMedia(
      new Request(`https://example.test${mediaUrl}`, { headers: { Range: "bytes=1-" } }),
      mediaUrl,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 1-${chunkSize * 3 - 1}/${chunkSize * 3}`,
    );
    expect((await response.arrayBuffer()).byteLength).toBe(chunkSize * 3 - 1);
    expect(match.mock.calls.map(([url]) => url)).toEqual([
      mediaUrl,
      `${mediaUrl}/chunk/0`,
      `${mediaUrl}/chunk/1`,
      `${mediaUrl}/chunk/2`,
    ]);
  });
});
