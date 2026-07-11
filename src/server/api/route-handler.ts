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

export function withQueryParams<S extends z.ZodType>(
  paramsSchema: S,
  handler: (context: QueryContext<z.infer<S>>) => Promise<Response>,
) {
  return withQuery<unknown>(async (context) => {
    const parsed = paramsSchema.safeParse(context.params);
    if (!parsed.success) return Response.json({ error: "Not found" }, { status: 404 });
    return handler({ ...context, params: parsed.data });
  });
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

export function withMutationParams<PS extends z.ZodType, BS extends z.ZodType>(
  paramsSchema: PS,
  bodySchema: BS,
  invalidMessage: string,
  handler: (context: MutationContext<z.infer<PS>, z.infer<BS>>) => Promise<Response>,
) {
  return withRawMutation<unknown>(async (context) => {
    const params = paramsSchema.safeParse(context.params);
    if (!params.success) return Response.json({ error: "Not found" }, { status: 404 });
    const body = bodySchema.safeParse(await context.request.json().catch(() => null));
    if (!body.success) return Response.json({ error: invalidMessage }, { status: 400 });
    return handler({ ...context, params: params.data, data: body.data });
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

export function withRawMutationParams<PS extends z.ZodType>(
  paramsSchema: PS,
  handler: (context: QueryContext<z.infer<PS>>) => Promise<Response>,
) {
  return withRawMutation<unknown>(async (context) => {
    const parsed = paramsSchema.safeParse(context.params);
    if (!parsed.success) return Response.json({ error: "Not found" }, { status: 404 });
    return handler({ ...context, params: parsed.data });
  });
}
