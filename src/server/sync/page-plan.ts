/**
 * How one page of the book cursor scan is cut. Pure, because the two ways to
 * get this wrong are both silent:
 *
 * - a watermark that is not strictly ahead of every row the page skipped makes
 *   the next pull re-select the same rows forever;
 * - a watermark ahead of a row the page did not carry loses that row for good.
 *
 * Cursors are the fixed-width microsecond UTC text `pull.ts` asks Postgres for,
 * so string order is timestamp order.
 */

export type BookPagePlan =
  /** Every changed row fitted; `watermark` covers the whole stream. */
  | { kind: "final"; take: number; watermark: string }
  /** Take the first `take` rows; rows at `watermark` and later remain. */
  | { kind: "partial"; take: number; watermark: string }
  /**
   * The page filled with a single timestamp, so no split is possible without
   * stranding rows. The caller must fetch that whole timestamp group instead.
   */
  | { kind: "bucket"; boundary: string };

/**
 * @param cursors the `updatedAt` cursor of each row fetched, ascending, with
 *   one row read past `pageSize` to detect more work.
 */
export function planBookPage(cursors: string[], floor: string, pageSize: number): BookPagePlan {
  if (cursors.length <= pageSize) {
    return { kind: "final", take: cursors.length, watermark: cursors.at(-1) || floor };
  }
  const boundary = cursors[pageSize]!;
  const take = cursors.slice(0, pageSize).filter((cursor) => cursor < boundary).length;
  if (!take) return { kind: "bucket", boundary };
  return { kind: "partial", take, watermark: cursors[take - 1]! };
}
