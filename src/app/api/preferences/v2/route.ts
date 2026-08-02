// The path itself is a mixed-deployment safety boundary. New clients write
// here, so predecessor instances that cannot persist idempotency receipts
// reject the request as unknown instead of applying it ambiguously.
import { makePreferencesPatch } from "@/server/preferences/patch-handler";

export const runtime = "nodejs";
export const PATCH = makePreferencesPatch({ strict: true });
