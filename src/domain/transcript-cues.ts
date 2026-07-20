/**
 * Cue lookup for the read-along view. Sentence and word cues are ordered by
 * non-decreasing startMs (enforced at import), so the active cue at any
 * playhead position is a binary search away — a 40-minute chapter's cue list
 * costs ~12 comparisons per tick, never a scan.
 */

type StartTimed = { startMs: number };

/**
 * Index of the last cue with startMs <= timeMs, or -1 before the first cue.
 * Cues stay "active" until the next one starts, which matches narration:
 * highlights persist through inter-sentence pauses instead of flickering off.
 */
export function activeCueIndex(cues: readonly StartTimed[], timeMs: number): number {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle]!.startMs <= timeMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
