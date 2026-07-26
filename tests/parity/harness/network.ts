import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * A network the test can physically unplug, sitting between the browser and the
 * app server.
 *
 * Why not `context.setOffline(true)`: WebKit refuses to NAVIGATE while the
 * context is offline ("WebKit encountered an internal error"), and every parity
 * assertion in this suite is about launching the SAME URL with the network gone.
 * `tests/sync/harness/app.ts` documents the same limitation and works around it
 * by never reloading while offline — a parity suite cannot.
 *
 * Why not `context.route("**\/*").abort()`: that is Playwright interception,
 * which sits ABOVE the service worker. The sync harness measured a control
 * request coming back HTTP 200 with every route aborted, because a fetch the
 * worker declines to handle is reissued outside the interception. An offline
 * proof that can be bypassed by the thing under test is not a proof.
 *
 * So the network is removed where it cannot be bypassed: the socket. When cut,
 * every inbound connection and every in-flight request is destroyed, so a fetch
 * REJECTS exactly as it does on a plane. The browser itself stays "online", so
 * the service worker still gets its chance to answer a navigation — which is the
 * behaviour under test.
 *
 * The proxy also counts what actually reached the app server. That is the
 * independent half of the offline proof: a control fetch failing says the page
 * could not reach the server, and a hit count of zero says nothing else did
 * either.
 */

export type NetworkHit = { method: string; path: string; kind: "document" | "api" | "asset" };

export type ControllableNetwork = {
  /** Origin the browser must use. Never the app's own origin. */
  origin: string;
  cut(): void;
  restore(): void;
  isCut(): boolean;
  /** Forgets recorded hits; does not change the cut/restored state. */
  reset(): void;
  hits(): NetworkHit[];
  /** Requests that arrived while cut and were destroyed rather than forwarded. */
  blockedCount(): number;
  close(): Promise<void>;
};

function classify(pathname: string, headers: IncomingHttpHeaders): NetworkHit["kind"] {
  if (pathname.startsWith("/api/")) return "api";
  if (String(headers["sec-fetch-mode"] ?? "") === "navigate") return "document";
  if (String(headers.accept ?? "").includes("text/html")) return "document";
  return "asset";
}

export async function startControllableNetwork(target: string): Promise<ControllableNetwork> {
  const targetUrl = new URL(target);
  const targetHost = targetUrl.hostname;
  const targetPort = Number(targetUrl.port || 80);
  const targetOrigin = targetUrl.origin;

  let cut = false;
  let blocked = 0;
  let hits: NetworkHit[] = [];
  let origin = "";
  const openSockets = new Set<Socket>();

  const rewriteRequestHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const next: IncomingHttpHeaders = { ...headers };
    // `trustedOrigins` and BETTER_AUTH_URL name the app's own origin, so the hop
    // presents itself as that origin. Auth, CSRF and Next's origin checks then
    // run on their normal path and this suite measures the product rather than a
    // misconfigured proxy.
    next.host = `${targetHost}:${targetPort}`;
    for (const key of ["origin", "referer"] as const) {
      const value = headers[key];
      if (typeof value === "string" && origin && value.startsWith(origin)) {
        next[key] = targetOrigin + value.slice(origin.length);
      }
    }
    delete next.connection;
    return next;
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (cut) {
      blocked += 1;
      req.socket.destroy();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    hits.push({
      method: req.method ?? "GET",
      path: pathname,
      kind: classify(pathname, req.headers),
    });

    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: rewriteRequestHeaders(req.headers),
      },
      (upstreamRes) => {
        const headers = { ...upstreamRes.headers };
        const location = headers.location;
        if (typeof location === "string" && location.startsWith(targetOrigin)) {
          headers.location = origin + location.slice(targetOrigin.length);
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`parity network upstream error: ${error.message}`);
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connection", (socket: Socket) => {
    // Counted here as well as in the request handler: while cut, the socket is
    // destroyed before any request line is parsed, so the connection attempt is
    // the only trace an offline fetch leaves. Without it, "nothing reached the
    // server" could not be told apart from "nothing was ever attempted", and a
    // library that had quietly stopped revalidating would look like a pass.
    if (cut) {
      blocked += 1;
      socket.destroy();
      return;
    }
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  // `localhost`, not 127.0.0.1: the auth cookie is host-only and cookies ignore
  // port, so one hostname across both hops keeps the session attached.
  origin = `http://localhost:${port}`;

  return {
    origin,
    cut: () => {
      cut = true;
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
    },
    restore: () => {
      cut = false;
    },
    isCut: () => cut,
    reset: () => {
      hits = [];
      blocked = 0;
    },
    hits: () => [...hits],
    blockedCount: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
