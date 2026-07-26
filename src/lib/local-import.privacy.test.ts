import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";

import { importLocalMp3, parseLocalMp3 } from "./local-import";

const FIXTURE = join(__dirname, "..", "..", "tests", "fixtures", "transcripts", "tiny-book.mp3");

// Words that exist ONLY inside the embedded transcript payload (the book text
// is not in any audio tag), so their presence in a request would prove leakage.
const TRANSCRIPT_MARKERS = ["lantern", "flickered", "sentences", "charStart", "granularity"];

const storeBookTranscript = vi.hoisted(() => vi.fn(async () => undefined));
const storeLocalBookMedia = vi.hoisted(() => vi.fn(async () => ({}) as never));

vi.mock("./offline/transcript-store", () => ({ storeBookTranscript }));
// Only the byte-writing half is stubbed; `withLocalMediaSlot` stays real, so
// the import still runs inside the media slot the product holds.
vi.mock("./offline/media-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./offline/media-store")>()),
  storeLocalBookMedia,
}));

function fixtureFile(): File {
  const bytes = readFileSync(FIXTURE);
  return new File([bytes], "tiny-book.mp3", { type: "audio/mpeg" });
}

// An import journals its registration in the outbox before it touches the
// network, so the module under test needs IndexedDB for the queue and
// localStorage for the device id it attributes the mutation to. Neither is a
// place transcript content could hide: both are on-device stores, and the
// assertions below still watch every `fetch` the import makes.
beforeEach(() => {
  vi.stubGlobal("indexedDB", new FakeIDBFactory());
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

describe("import privacy", () => {
  it("parses the embedded transcript from the fixture", async () => {
    const parsed = await parseLocalMp3(fixtureFile());
    expect(parsed.transcript).not.toBeNull();
    expect(parsed.transcript!.chapters).toHaveLength(2);
    expect(parsed.transcriptDiagnostic).toBeNull();
  });

  it("never sends transcript content in any server request", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ bookId: "book-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await importLocalMp3("user-1", fixtureFile(), () => undefined);

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const haystack = `${request.url}\n${request.body}`.toLowerCase();
      expect(haystack).not.toContain("transcript");
      for (const marker of TRANSCRIPT_MARKERS) {
        expect(haystack).not.toContain(marker.toLowerCase());
      }
    }

    // The cues do get stored — on this device only.
    expect(storeBookTranscript).toHaveBeenCalledTimes(1);
    const [, , stored] = storeBookTranscript.mock.calls[0]! as unknown as [
      string,
      string,
      { chapters: unknown[] },
    ];
    expect(stored.chapters).toHaveLength(2);
  });

  it("imports the audio cleanly when the transcript frame is malformed", async () => {
    // Corrupt only the GEOB payload: flip bytes inside the gzip data region.
    const bytes = readFileSync(FIXTURE);
    const marker = Buffer.from("EPUB_LISTENER_TRANSCRIPT\0");
    const at = bytes.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const corrupted = Buffer.from(bytes);
    for (let i = at + marker.length; i < at + marker.length + 64; i += 1) {
      corrupted[i] = corrupted[i]! ^ 0xff;
    }
    const file = new File([corrupted], "corrupted.mp3", { type: "audio/mpeg" });

    const parsed = await parseLocalMp3(file);
    expect(parsed.transcript).toBeNull();
    expect(parsed.transcriptDiagnostic).toMatch(/Transcript rejected/);
    expect(parsed.chapters).toHaveLength(2);

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ bookId: "book-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await importLocalMp3("user-1", file, () => undefined);
    expect(storeBookTranscript).not.toHaveBeenCalled();
    expect(storeLocalBookMedia).toHaveBeenCalledTimes(1);
  });
});
