// The path itself is a mixed-deployment safety boundary. New clients write
// here, so predecessor instances that cannot persist idempotency receipts
// reject the request as unknown instead of applying it ambiguously.
export const runtime = "nodejs";
export { PATCH } from "../route";
