/**
 * The web service's link to the api service: /api and /rivet requests are
 * forwarded unchanged over the private network, sockets included.
 *
 * The api applies every policy (origin allowlist, engine admin denial, engine
 * credentials, rate limits); this hop only moves bytes. It does three things:
 *
 *   - CLIENT IDENTITY: X-Forwarded-For is replaced with the one trusted client
 *     address (deriveTrustedClientIp), so the api sees the browser's address,
 *     never a value the browser chose. X-Forwarded-Host and -Proto carry the
 *     public host so the api can build public URLs.
 *   - SPREAD: the api's private name resolves to every replica. Each request
 *     and socket takes the next address, so load spreads across replicas
 *     instead of pinning to the first DNS answer.
 *   - FAILOVER: a request that could not connect (a replica draining during a
 *     deploy) is retried once on the next address when it has no body.
 */
import type { Server } from "bun";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { log as logger } from "@example/config";
import { deriveTrustedClientIp } from "./gateway.ts";
import {
  createSocketRelay,
  type SocketRelay,
  type WsConnData,
} from "./relay.ts";

const HTTP_TIMEOUT_MS = 120_000;
const DNS_TTL_MS = 5_000;

const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "x-real-ip",
]);
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

/** Round-robin over the addresses a private service name resolves to. */
export interface UpstreamPool {
  /** The next base URL, e.g. `http://[fd12::3]:8080`. */
  next(): Promise<string>;
}

export function createUpstreamPool(
  origin: string,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((record) => record.address),
): UpstreamPool {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const fixed = isIP(host) !== 0 || host === "localhost" ? url.origin : null;
  let addresses: string[] = [];
  let resolvedAt = 0;
  let cursor = 0;

  const base = (address: string) => {
    const shown = isIP(address) === 6 ? `[${address}]` : address;
    return `${url.protocol}//${shown}${url.port ? `:${url.port}` : ""}`;
  };

  return {
    async next() {
      if (fixed) return fixed;
      if (Date.now() - resolvedAt > DNS_TTL_MS) {
        try {
          const found = await resolve(host);
          if (found.length > 0) addresses = found;
        } catch (error) {
          // Keep the last good answer; with none, fall back to the name.
          logger.warn("forwarder: upstream did not resolve", {
            host,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        resolvedAt = Date.now();
      }
      if (addresses.length === 0) return url.origin;
      cursor = (cursor + 1) % addresses.length;
      return base(addresses[cursor]!);
    },
  };
}

export interface ForwarderOptions {
  /** The api service's origin, e.g. `http://api.railway.internal:8080`. */
  upstream: string;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /** Override DNS (tests). */
  resolve?: (host: string) => Promise<string[]>;
}

export interface Forwarder {
  /** Bun routes handler. Undefined after a socket upgrade. */
  handle(
    req: Request,
    server: Server<WsConnData>,
  ): Promise<Response | undefined>;
  websocket: SocketRelay["websocket"];
}

export function createForwarder(opts: ForwarderOptions): Forwarder {
  const log = opts.log ?? logger;
  const pool = createUpstreamPool(opts.upstream, opts.resolve);
  const relay = createSocketRelay({ log, label: "forwarder" });

  const identity = (req: Request, server: Server<WsConnData>) => {
    const url = new URL(req.url);
    return {
      clientIp: deriveTrustedClientIp(
        req.headers.get("x-forwarded-for"),
        server.requestIP(req)?.address ?? null,
      ),
      host:
        req.headers.get("x-forwarded-host") ??
        req.headers.get("host") ??
        url.host,
      proto:
        req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        url.protocol.replace(":", ""),
    };
  };

  const forwardHttp = async (
    req: Request,
    server: Server<WsConnData>,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const who = identity(req, server);
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!DROP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
    });
    if (who.clientIp) headers.set("x-forwarded-for", who.clientIp);
    headers.set("x-forwarded-host", who.host);
    headers.set("x-forwarded-proto", who.proto);

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const attempts = hasBody ? 1 : 2;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const base = await pool.next();
      try {
        const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: "manual",
          signal: AbortSignal.any([
            req.signal,
            AbortSignal.timeout(HTTP_TIMEOUT_MS),
          ]),
          // Bun: stream request bodies instead of buffering them.
          ...(hasBody ? { duplex: "half" } : {}),
        } as RequestInit);
        const out = new Headers();
        upstream.headers.forEach((value, key) => {
          if (!DROP_RESPONSE.has(key.toLowerCase())) out.set(key, value);
        });
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: out,
        });
      } catch (error) {
        if (req.signal.aborted) return new Response(null, { status: 499 });
        lastError = error;
      }
    }
    log.warn("forwarder: api unreachable", {
      path: url.pathname,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return Response.json({ error: "api_unreachable" }, { status: 502 });
  };

  return {
    async handle(req, server) {
      const isUpgrade =
        req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isUpgrade) return forwardHttp(req, server);

      const url = new URL(req.url);
      const who = identity(req, server);
      const offered = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const base = (await pool.next()).replace(/^http/i, "ws");
      const upgraded = relay.upgrade(
        req,
        server,
        {
          upstreamUrl: `${base}${url.pathname}${url.search}`,
          protocols: offered,
          origin: req.headers.get("origin"),
          clientIp: who.clientIp,
        },
        // The rivet client offers "rivet" plus encoded parameters; the api
        // selects "rivet", so this leg must too.
        offered.includes("rivet") ? { "Sec-WebSocket-Protocol": "rivet" } : {},
      );
      return upgraded
        ? undefined
        : Response.json({ error: "upgrade_failed" }, { status: 400 });
    },
    websocket: relay.websocket,
  };
}
