import "server-only";

import { z } from "zod";

import { auth } from "@/server/auth";
import { isTrustedMutationOrigin } from "@/server/security/request-origin";

export type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type RouteArgs<P> = { params: Promise<P> };

type QueryContext<P> = { request: Request; session: RouteSession; params: P };
type MutationContext<P, D> = QueryContext<P> & { data: D };

/** Authenticated read handler: resolves the session (401 otherwise) and params. */
export function withQuery<P = Record<string, never>>(
  handler: (context: QueryContext<P>) => Promise<Response>,
) {
  return async (request: Request, routeArgs?: RouteArgs<P>): Promise<Response> => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const params = routeArgs ? await routeArgs.params : ({} as P);
    return handler({ request, session, params });
  };
}

/**
 * Authenticated write handler with a JSON body: origin check (403), session
 * (401), and schema validation (400) happen in exactly one place.
 */
export function withMutation<S extends z.ZodType, P = Record<string, never>>(
  schema: S,
  invalidMessage: string,
  handler: (context: MutationContext<P, z.infer<S>>) => Promise<Response>,
) {
  return withRawMutation<P>(async (context) => {
    const parsed = schema.safeParse(await context.request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: invalidMessage }, { status: 400 });
    return handler({ ...context, data: parsed.data });
  });
}

/** Authenticated write handler that manages its own body (uploads, deletes). */
export function withRawMutation<P = Record<string, never>>(
  handler: (context: QueryContext<P>) => Promise<Response>,
) {
  return async (request: Request, routeArgs?: RouteArgs<P>): Promise<Response> => {
    if (!isTrustedMutationOrigin(request)) {
      return Response.json({ error: "Untrusted request origin." }, { status: 403 });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const params = routeArgs ? await routeArgs.params : ({} as P);
    return handler({ request, session, params });
  };
}
