import { env } from "@/server/env";

export function isTrustedMutationOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return false;
  }
}
