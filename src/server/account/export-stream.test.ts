import { describe, expect, it } from "vitest";

import { AsyncChunkChannel } from "./async-chunk-channel";

describe("export backpressure channel", () => {
  it("unblocks and rejects a producer when the consumer cancels", async () => {
    const channel = new AsyncChunkChannel();
    await channel.push(new Uint8Array([1]));
    const blocked = channel.push(new Uint8Array([2]));

    channel.cancel();

    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
  });
});
