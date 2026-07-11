export class AsyncChunkChannel implements AsyncIterable<Uint8Array> {
  private queued: Uint8Array | null = null;
  private reader: ((result: IteratorResult<Uint8Array>) => void) | null = null;
  private space: (() => void) | null = null;
  private closed = false;
  private error: unknown;
  private cancelled = false;

  async push(chunk: Uint8Array): Promise<void> {
    if (this.cancelled) throw new DOMException("Export canceled.", "AbortError");
    if (this.reader) {
      const reader = this.reader;
      this.reader = null;
      reader({ value: chunk, done: false });
      return;
    }
    while (this.queued) {
      if (this.cancelled) throw new DOMException("Export canceled.", "AbortError");
      await new Promise<void>((resolve) => (this.space = resolve));
    }
    if (this.cancelled) throw new DOMException("Export canceled.", "AbortError");
    this.queued = chunk;
  }

  close(): void {
    this.closed = true;
    this.reader?.({ value: undefined, done: true });
    this.reader = null;
  }

  fail(error: unknown): void {
    this.error = error;
    this.close();
  }

  cancel(): void {
    this.cancelled = true;
    this.space?.();
    this.space = null;
    this.fail(new DOMException("Export canceled.", "AbortError"));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      if (this.queued) {
        const chunk = this.queued;
        this.queued = null;
        this.space?.();
        this.space = null;
        yield chunk;
        continue;
      }
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<Uint8Array>>(
        (resolve) => (this.reader = resolve),
      );
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}
