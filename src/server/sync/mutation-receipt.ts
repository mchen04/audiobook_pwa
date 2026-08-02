import "server-only";

import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/server/db/client";
import { playbackActionReceipts } from "@/server/db/schema";

export type ReceiptClaim = {
  /** True the first time this `mutationId` is seen; false on every replay. */
  claimed: boolean;
  recordedAt: Date | null;
};

/**
 * The one idempotency ledger.
 *
 * `playback_action_receipts` already is the durable record of "this device's
 * mutation has been applied" — `server/playback/history.ts` has used it that
 * way since playback history shipped. Rather than stand up a second ledger with
 * its own retention and its own bugs, this generalizes the same claim so any
 * book-scoped mutation replayed from the outbox can be deduped by the
 * `mutationId` the device generated once at queue time.
 *
 * Must be called inside the transaction that performs the write, so the claim
 * and the effect commit together. A claim without its effect would make the
 * mutation permanently invisible; an effect without its claim would let a
 * replay apply it twice.
 */
export async function claimMutationReceipt(
  transaction: Transaction,
  input: { mutationId: string; userId: string; bookId: string },
): Promise<ReceiptClaim> {
  const [inserted] = await transaction
    .insert(playbackActionReceipts)
    .values({ id: input.mutationId, userId: input.userId, bookId: input.bookId })
    .onConflictDoNothing({ target: playbackActionReceipts.id })
    .returning({ recordedAt: playbackActionReceipts.recordedAt });
  if (inserted) return { claimed: true, recordedAt: inserted.recordedAt };

  const [existing] = await transaction
    .select({ recordedAt: playbackActionReceipts.recordedAt })
    .from(playbackActionReceipts)
    .where(
      and(
        eq(playbackActionReceipts.id, input.mutationId),
        eq(playbackActionReceipts.userId, input.userId),
        eq(playbackActionReceipts.bookId, input.bookId),
      ),
    )
    .limit(1);
  return { claimed: false, recordedAt: existing?.recordedAt ?? null };
}
