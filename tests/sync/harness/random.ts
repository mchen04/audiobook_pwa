/**
 * A seeded PRNG, so a red seed reproduces exactly.
 *
 * mulberry32: 32 bits of state, uniform enough for choosing between a dozen
 * operations, and — the only property that matters here — identical output for
 * identical input on every machine and every Node version.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new Error("Random.pick on an empty list");
    return values[this.int(values.length)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
