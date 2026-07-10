export type ByteRange = {
  start: number;
  end: number;
  length: number;
};

export class UnsatisfiableRangeError extends Error {
  constructor() {
    super("The requested byte range cannot be satisfied.");
    this.name = "UnsatisfiableRangeError";
  }
}

export function parseByteRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  if (!Number.isSafeInteger(size) || size <= 0) throw new UnsatisfiableRangeError();

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new UnsatisfiableRangeError();

  const [, startText, endText] = match;
  if (!startText && !endText) throw new UnsatisfiableRangeError();

  let start: number;
  let end: number;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new UnsatisfiableRangeError();
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new UnsatisfiableRangeError();
    }

    if (start >= size) throw new UnsatisfiableRangeError();
    end = Math.min(end, size - 1);
  }

  return { start, end, length: end - start + 1 };
}
