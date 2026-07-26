import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A controllable network stands between the browser and the app server.
 *
 * Two things were established by experiment before this was written, and this
 * file exists because of them:
 *
 *  - `context.route()` delays do NOT reliably apply to requests that pass
 *    through a service worker (a control fetch under a 3000ms route delay came
 *    back in 2ms). A delay a service worker can bypass is not a network
 *    profile, it is decoration. So the latency lives in a real socket hop
 *    between the browser and the app — exactly where a cold database's cost
 *    shows up from the browser's point of view.
 *  - Timing alone cannot tell "served from Cache Storage" apart from "the
 *    server happened to be fast", and it passes silently when the service
 *    worker falls through to the network on a cache miss. So this proxy also
 *    counts what actually reached the server, per class of request.
 */

export const PROBE_PATH = "/api/perf/probe";

export type HitCounts = {
  /** Navigation/document requests that reached the app server. */
  document: number;
  /** `/api/` requests that reached the app server (the probe is excluded). */
  api: number;
  /** Everything else that reached the app server (scripts, css, fonts, icons). */
  asset: number;
  /** Probe requests answered by the proxy itself; never forwarded. */
  probe: number;
};

export type ProxyReport = HitCounts & { total: number; documentPaths: string[] };

export type LatencyProxy = {
  origin: string;
  port: number;
  setDelay(ms: number): void;
  getDelay(): number;
  reset(): void;
  report(): ProxyReport;
  close(): Promise<void>;
};

function emptyCounts(): HitCounts {
  return { document: 0, api: 0, asset: 0, probe: 0 };
}

/**
 * Documents are identified by the Accept header the browser sends for a
 * navigation. Deliberately conservative: anything that asks for HTML counts as
 * a document hit, so a stray HTML fetch can never hide inside "asset".
 */
function classify(pathname: string, headers: IncomingHttpHeaders): keyof HitCounts {
  if (pathname === PROBE_PATH) return "probe";
  if (pathname.startsWith("/api/")) return "api";
  const accept = String(headers.accept ?? "");
  if (accept.includes("text/html")) return "document";
  if (String(headers["sec-fetch-mode"] ?? "") === "navigate") return "document";
  return "asset";
}

export async function startLatencyProxy(target: string): Promise<LatencyProxy> {
  const targetUrl = new URL(target);
  const targetHost = targetUrl.hostname;
  const targetPort = Number(targetUrl.port || 80);
  const targetOrigin = targetUrl.origin;

  let delayMs = 0;
  let counts = emptyCounts();
  const documentPaths: string[] = [];
  let origin = "";

  const rewriteRequestHeaders = (headers: IncomingHttpHeaders): IncomingHttpHeaders => {
    const next: IncomingHttpHeaders = { ...headers };
    // The app is configured with BETTER_AUTH_URL/trustedOrigins pointing at the
    // real server origin. Presenting the proxy hop as that origin keeps auth,
    // CSRF and Next's own origin checks on their normal path, so the benchmark
    // measures the launch and not a misconfigured proxy.
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
    const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    const kind = classify(pathname, req.headers);
    counts[kind] += 1;
    if (kind === "document") documentPaths.push(`${req.method} ${req.url}`);

    const pending = delayMs;
    req.pause();

    setTimeout(() => {
      if (kind === "probe") {
        // Answered here so the control request measures this proxy's delay and
        // nothing else. It is never forwarded, so it cannot be cached anywhere.
        res.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store, no-cache, must-revalidate",
        });
        res.end(`probe delay=${pending}`);
        req.resume();
        return;
      }

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
        res.end(`latency proxy upstream error: ${error.message}`);
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    }, pending);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  // `localhost` rather than 127.0.0.1: the auth cookie is host-only, and using
  // one hostname for both hops keeps it attached across the proxy.
  origin = `http://localhost:${port}`;

  return {
    origin,
    port,
    setDelay: (ms) => {
      delayMs = ms;
    },
    getDelay: () => delayMs,
    reset: () => {
      counts = emptyCounts();
      documentPaths.length = 0;
    },
    report: () => ({
      ...counts,
      total: counts.document + counts.api + counts.asset + counts.probe,
      documentPaths: [...documentPaths],
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
