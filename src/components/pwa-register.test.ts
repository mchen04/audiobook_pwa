import { parseBlob } from "music-metadata";
import { describe, expect, it } from "vitest";

import { mp3ParserWarmupFrame } from "./pwa-register";

/**
 * The import path's lazy chunks are pulled in after every launch paint so that
 * importing a book with no network works at all. `music-metadata` needs two
 * hops for that — the package, then the parser its loader table reaches through
 * `import("./MpegParser.js")` — and the second one happens only when something
 * is actually parsed.
 *
 * Which makes the warm-up silently fragile: bytes that parse as nothing resolve
 * no parser, and the ready flag goes up anyway. The offline import then fails on
 * a chunk fetch, with the caching race dressed up as an import bug. So the bytes
 * are checked here, through the real parser, rather than trusted.
 */
describe("the MP3 parser warm-up", () => {
  it("parses as an MP3, which is what makes it resolve the parser", async () => {
    const parsed = await parseBlob(new Blob([mp3ParserWarmupFrame()], { type: "audio/mpeg" }), {
      duration: false,
    });

    expect(
      parsed.format.container,
      "the warm-up bytes are not recognised as MPEG audio, so `mpegParserLoader.load()` never " +
        "runs and the chunk the offline import needs stays on the network",
    ).toBe("MPEG");
    expect(parsed.format.codec).toBe("MPEG 1 Layer 3");
  });

  it("is one whole frame, so nothing is left waiting for more bytes", () => {
    // 144 * 128000 / 44100 = 417 bytes for the header this frame declares.
    expect(mp3ParserWarmupFrame()).toHaveLength(417);
  });
});
