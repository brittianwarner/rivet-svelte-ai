/**
 * The `/rivet` edge: browsers reach the engine only through this relay.
 *
 * The engine's Guard port also serves admin APIs (namespaces, pools, tokens,
 * actor CRUD, node registration). The engine therefore never gets a public
 * port, and this proxy forwards only the actor data plane.
 *
 *   - ALLOWLIST: `/gateway/:selector` connect, websocket, action, queue and
 *     request, plus a static `/metadata` stub. Everything else is a 404 from
 *     here and is never forwarded, so a new engine admin route is denied by
 *     default.
 *   - ORIGIN GATE: a request with an Origin header must match the allowlist.
 *     Origin-less callers (scripts) pass; the actor's own connection check is
 *     the authorization boundary either way.
 *   - ENGINE CREDENTIAL: the engine authenticates every `/gateway` request.
 *     The proxy attaches a namespace-scoped JWT on the upstream leg only
 *     (`x-rivet-token` on HTTP, a `rivet_token.<jwt>` subprotocol on dial).
 *     It is minted from the admin token (engine-token.ts), never sent to the
 *     browser and never logged. No credential means 503, never the admin token.
 *   - CREDENTIAL HYGIENE: browser-supplied engine credentials are stripped:
 *     `x-rivet-token`, `authorization`, `cookie`, `rivet_token.*` subprotocols,
 *     the `rvt-token` query key, and the `actorId@token` selector (refused).
 *
 * Connection params (the actor-level credential) ride the
 * `rivet_conn_params.*` subprotocol through the relay as opaque bytes and are
 * checked inside the actor's `onBeforeConnect`.
 *
 * Relay mechanics: bounded FIFO buffers in both directions (a slow tab can
 * never grow memory without bound; over the cap both legs close 1013), close
 * codes mirrored both ways, upstream errors mapped to 1011 so the client's
 * reconnect-with-backoff takes over.
 *
 * Ported from a production relay; see the tests for the contract.
 */
import type { Server, WebSocketHandler } from "bun";
import { isIP } from "node:net";
import { log as logger } from "@example/config";
import type { EngineCredentialProvider } from "./engine-token.ts";
import {
  WS_PROTOCOL_TOKEN_PREFIX,
  createSocketRelay,
  type WsConnData,
} from "./relay.ts";

export { capWsCloseReason, type WsConnData } from "./relay.ts";

// ---- Tunables ----------------------------------------------------------------

/** HTTP passthrough ceiling; above the engine's own action/request timeouts. */
const HTTP_PROXY_TIMEOUT_MS = 120_000;

// ---- Pure route classification (the allowlist) --------------------------------

export type ProxyRouteKind = "metadata" | "http" | "ws" | "deny";

export interface ProxyRoute {
  kind: ProxyRouteKind;
  /** Path with the mount prefix stripped — what gets appended to the upstream base. */
  upstreamPath: string;
}

const GATEWAY_SEG = String.raw`[^/]+`; // actor name OR actorId[@token]
const WS_PATH_RE = new RegExp(
  `^/gateway/${GATEWAY_SEG}(?:/connect|/websocket(?:/.*)?)$`,
);
const HTTP_GATEWAY_RE = new RegExp(
  `^/gateway/${GATEWAY_SEG}(?:/action/[^/]+|/queue/[^/]+|/request(?:/.*)?)$`,
);

/**
 * Classify an incoming path against the client wire-contract allowlist.
 * `pathname` includes the mount prefix (e.g. /rivet/gateway/user/connect).
 * Prefix stripping is strict — a path outside the mount is denied.
 *
 * The browser client must use `gateway.skipReadyWait=true`, so connections
 * and actions target an actor query directly. That keeps every data-plane
 * request behind the actor's onBeforeConnect authorization and lets this edge
 * deny GET/PUT/POST/DELETE /actors in full. Dynamic reload is denied too: its
 * client call carries no connection params and therefore has no actor HMAC.
 * /metadata is NEVER proxied to the engine — a static stub is answered locally
 * so the engine cannot hand a browser a clientEndpoint/clientToken.
 */
export function classifyProxyPath(
  pathname: string,
  method: string,
  isUpgrade: boolean,
  prefix = "/rivet",
): ProxyRoute {
  if (!pathname.startsWith(prefix)) return { kind: "deny", upstreamPath: "" };
  const path = pathname.slice(prefix.length) || "/";
  const m = method.toUpperCase();

  if (path === "/metadata" && m === "GET") {
    return { kind: "metadata", upstreamPath: path };
  }
  if (WS_PATH_RE.test(path)) {
    return isUpgrade
      ? { kind: "ws", upstreamPath: path }
      : { kind: "deny", upstreamPath: "" };
  }
  if (HTTP_GATEWAY_RE.test(path)) {
    return isUpgrade
      ? { kind: "deny", upstreamPath: "" }
      : { kind: "http", upstreamPath: path };
  }
  return { kind: "deny", upstreamPath: "" };
}

// ---- Browser-credential stripping ---------------------------------------------

function isTokenProtocol(entry: string): boolean {
  return entry.toLowerCase().startsWith(WS_PROTOCOL_TOKEN_PREFIX);
}

/** Split a Sec-WebSocket-Protocol header and drop every engine-token entry. */
export function stripTokenProtocols(header: string | null): string[] {
  return (header ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !isTokenProtocol(p));
}

function decodeQueryKey(rawKey: string): string | null {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

export type UpstreamTarget =
  { ok: true; path: string; search: string } | { ok: false };

/**
 * Remove engine-credential carriers the browser could place in the path or
 * query. Mirrors the engine's own parsing (pegboard-gateway routes.rs):
 *   - `rvt-token` is read from the DECODED query key, so `rvt%2Dtoken` counts;
 *     matched case-insensitively here to stay conservative. Pairs whose key
 *     cannot be decoded are dropped. All other pairs pass byte-for-byte.
 *   - an `{actorId}@{token}` selector is only read as a token when the request
 *     has no `rvt-method` (a keyed selector is an actor name). The selector
 *     arrives percent-decoded at the engine, so it is decoded here before the
 *     check; such a request is refused rather than rewritten.
 */
export function sanitizeUpstreamTarget(params: {
  upstreamPath: string;
  search: string;
}): UpstreamTarget {
  const rawQuery = params.search.startsWith("?")
    ? params.search.slice(1)
    : params.search;
  const kept: string[] = [];
  let hasMethod = false;
  for (const pair of rawQuery.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decodeQueryKey(eq === -1 ? pair : pair.slice(0, eq));
    if (key === null) continue;
    // Strip `rvt-token` in any case (superset of the engine), but detect
    // `rvt-method` exactly as the engine's serde field does: a case variant
    // the engine ignores must not unlock the `@token` selector check below.
    if (key.toLowerCase() === "rvt-token") continue;
    if (key === "rvt-method") hasMethod = true;
    kept.push(pair);
  }
  const selector = params.upstreamPath.split("/")[2] ?? "";
  let decodedSelector: string;
  try {
    decodedSelector = decodeURIComponent(selector);
  } catch {
    return { ok: false };
  }
  if (!hasMethod && decodedSelector.includes("@")) return { ok: false };
  return {
    ok: true,
    path: params.upstreamPath,
    search: kept.length > 0 ? `?${kept.join("&")}` : "",
  };
}

/**
 * Origin gate. Browsers always send Origin on WS upgrades and CORS-flagged
 * fetches; those must match the allowlist. Origin-less requests (curl,
 * scripts, server-side probes) pass — actor HMAC verification is the
 * boundary for them, exactly as on Rivet Cloud.
 */
export function isOriginAllowed(
  origin: string | null,
  allowed: string[] | "*",
): boolean {
  if (origin === null) return true;
  if (allowed === "*") return true;
  return allowed.includes(origin);
}

/** http(s) → ws(s) for the upstream dial. */
export function toWebSocketBase(httpBase: string): string {
  return httpBase.replace(/^http/i, "ws");
}

function stripXffEntryPort(entry: string): string {
  const bracketed = entry.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed?.[1]) return bracketed[1];
  const v4WithPort = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort?.[1]) return v4WithPort[1];
  return entry;
}

// The unparseable-entry warn is throttled: deriveTrustedClientIp is also on
// unauthenticated request paths (the /api rate limiter), where the entry is
// attacker-supplied — unthrottled it is a free warn-log amplifier. One warn
// per window is all the signal "the edge format changed" needs.
const XFF_WARN_INTERVAL_MS = 60_000;
let lastXffWarnAt = 0;

/**
 * Trusted client IP for the engine's Guard rate-limit key.
 *
 * The Guard enforces a HARDCODED per-client-IP limit (10,000 req/60s + 2,000
 * in-flight — guard-core/src/request_context.rs; no config knob in 2.3.x) and
 * keys on the FIRST X-Forwarded-For entry when parseable, else the socket IP
 * (verified against engine 2.3.10, 2026-08-27; re-check after engine
 * upgrades). Before this
 * existed, every relayed browser connection reached the Guard from the api
 * service's single IP, so the entire platform shared ONE bucket and bulk
 * server-side traffic starved browser connects with `guard.rate_limit`.
 *
 * Stamping the real client IP gives every browser client its own bucket:
 * users can never rate-limit each other or be starved by server traffic,
 * while an actual abuser of the public /rivet surface still only exhausts
 * their own bucket.
 *
 * Trust order:
 *   1. LAST entry of the inbound X-Forwarded-For — appended by the nearest
 *      trusted hop (Railway's edge). Never the first entry: that one is
 *      client-forgeable, and forwarding it verbatim would let a client choose
 *      its own rate-limit bucket. Deliberately no backward walk on a
 *      non-parseable last entry — everything before it is client-supplied.
 *   2. The direct socket IP (local dev, private-network callers).
 *
 * Tolerates `ip:port` / `[v6]:port` entry shapes (RFC 7239-adjacent edge
 * formats). If the last entry is present but unparseable even after
 * port-stripping, a warn fires: that means an edge format change just
 * silently collapsed every browser into the shared socket-IP bucket — the
 * pre-incident topology — and the derivation needs updating.
 */
export function deriveTrustedClientIp(
  forwardedFor: string | null,
  socketAddress: string | null,
): string | null {
  if (forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) {
      const candidate = stripXffEntryPort(last);
      if (isIP(candidate) !== 0) return candidate;
      const now = Date.now();
      if (now - lastXffWarnAt >= XFF_WARN_INTERVAL_MS) {
        lastXffWarnAt = now;
        logger.warn(
          "rivet proxy: unparseable last X-Forwarded-For entry — falling back to socket IP (shared guard bucket)",
          // Client-controlled — keep printable ASCII only (no log injection).
          { entry: last.replace(/[^\x20-\x7e]/g, "?").slice(0, 64) },
        );
      }
    }
  }
  if (socketAddress && isIP(socketAddress) !== 0) return socketAddress;
  return null;
}

export interface RivetGatewayProxyOptions {
  /** Bare engine base URL, e.g. http://127.0.0.1:6420 (no userinfo, no path). */
  upstreamHttp: string;
  allowedOrigins: string[] | "*";
  /** Mount prefix the route is registered under. */
  prefix?: string;
  maxBufferedBytes?: number;
  upstreamDialTimeoutMs?: number;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /**
   * Source of the upstream-leg engine credential (engine 3.0). Omit for an
   * engine that needs none. See engine-token.ts.
   */
  engineCredential?: EngineCredentialProvider;
}

export interface RivetGatewayProxy {
  /** Bun routes-map handler: `(req, server)`. Returns undefined after a successful upgrade. */
  handleRequest: (
    req: Request,
    server: Server<WsConnData>,
  ) => Response | undefined | Promise<Response | undefined>;
  /** Bun.serve `websocket` handler block — active only for proxy-upgraded connections. */
  websocket: WebSocketHandler<WsConnData>;
}

const HOP_BY_HOP_REQ = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Credential hygiene, not hop-by-hop: browsers auto-attach the api
  // origin's session (Cookie, and any ambient Authorization)
  // to every /rivet/* request. The rivetkit client authenticates with
  // connection params via `x-rivet-conn-params` (verified
  // actor-router-consts.ts) and NEVER these headers, so stripping loses
  // nothing and keeps app session credentials off the engine.
  "cookie",
  "authorization",
  // Browser-supplied engine credential: the proxy attaches its own.
  "x-rivet-token",
  // Rebuilt below with engine-token entries removed.
  "sec-websocket-protocol",
  // Client-identity headers: the proxy derives the ONE trusted identity
  // itself (deriveTrustedClientIp → x-forwarded-for). The Guard (verified
  // on 2.3.10) keys only on X-Forwarded-For, but a future engine honoring the
  // standardized Forwarded header (or X-Real-IP et al.) would re-open
  // client-chosen rate-limit bucketing if these passed through.
  "forwarded",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "x-cluster-client-ip",
]);
const HOP_BY_HOP_RES = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function deny(status: 403 | 404 | 502 | 503, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function createRivetGatewayProxy(
  opts: RivetGatewayProxyOptions,
): RivetGatewayProxy {
  const prefix = opts.prefix ?? "/rivet";
  const log = opts.log ?? logger;
  const relay = createSocketRelay({
    maxBufferedBytes: opts.maxBufferedBytes,
    upstreamDialTimeoutMs: opts.upstreamDialTimeoutMs,
    log,
  });
  const upstreamHttp = opts.upstreamHttp.replace(/\/+$/, "");
  const upstreamWs = toWebSocketBase(upstreamHttp);

  const metadataStub = () =>
    // Deliberately empty: the rivetkit client only acts on camelCase
    // clientEndpoint/clientNamespace/clientToken overrides; absent keys mean
    // "keep the configured endpoint". A successful-but-empty body also keeps
    // any client WITHOUT disableMetadataLookup out of the forever-retry loop.
    new Response("{}", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });

  const passthroughHttp = async (
    req: Request,
    upstreamPath: string,
    search: string,
    clientIp: string | null,
    engineToken: string | null,
  ): Promise<Response> => {
    const upstreamUrl = `${upstreamHttp}${upstreamPath}${search}`;
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_REQ.has(key.toLowerCase())) headers.set(key, value);
    });
    // The engine reads Sec-WebSocket-Protocol tokens on plain HTTP too.
    const protocols = stripTokenProtocols(
      req.headers.get("sec-websocket-protocol"),
    );
    if (protocols.length > 0) {
      headers.set("sec-websocket-protocol", protocols.join(", "));
    }
    // Upstream-leg engine credential — set AFTER the copy so a browser value
    // can never win. Not logged anywhere in this module.
    if (engineToken) headers.set("x-rivet-token", engineToken);
    // Guard rate-limit key: OVERWRITE, never pass through — a forwarded
    // client-supplied X-Forwarded-For would let the client pick its own
    // bucket (the Guard trusts the first entry). See deriveTrustedClientIp.
    if (clientIp) {
      headers.set("x-forwarded-for", clientIp);
    } else {
      headers.delete("x-forwarded-for");
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS),
      });
      if (upstream.status === 429) {
        // Guard rate limit crossing the relay — the one place the browser
        // lane's saturation is visible server-side. Stable grep tag shared
        // with the elysia 503 mapping.
        log.warn("[guard-503] rivet proxy: upstream 429 (guard rate limit)", {
          path: upstreamPath,
          clientIp,
        });
      }
      const resHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_RES.has(key.toLowerCase())) resHeaders.set(key, value);
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      log.warn("rivet proxy: upstream HTTP error", {
        path: upstreamPath,
        error: err instanceof Error ? err.message : String(err),
      });
      // The engine is down or unreachable: a gateway error, not a missing route.
      return deny(502, "upstream_unreachable");
    }
  };

  const handleRequest = async (
    req: Request,
    server: Server<WsConnData>,
  ): Promise<Response | undefined> => {
    const url = new URL(req.url);
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const route = classifyProxyPath(
      url.pathname,
      req.method,
      isUpgrade,
      prefix,
    );

    if (route.kind === "deny") {
      // Proxy-level denial (never forwarded): admin surfaces share the Guard
      // port — /namespaces, /runner-configs, /datacenters, the dashboard.
      return deny(404, "not_found");
    }
    if (route.kind === "metadata") return metadataStub();

    const origin = req.headers.get("origin");
    if (!isOriginAllowed(origin, opts.allowedOrigins)) {
      log.warn("rivet proxy: origin rejected", { origin, path: url.pathname });
      return deny(403, "origin_not_allowed");
    }

    const clientIp = deriveTrustedClientIp(
      req.headers.get("x-forwarded-for"),
      server.requestIP(req)?.address ?? null,
    );

    // Strip path/query credential carriers (rvt-token, actorId@token).
    const target = sanitizeUpstreamTarget({
      upstreamPath: route.upstreamPath,
      search: url.search,
    });
    if (!target.ok) return deny(404, "not_found");

    // Engine credential for the upstream leg. Fail closed: never forward the
    // request tokenless to an engine that requires one, never fall back to
    // the admin token.
    let engineToken: string | null = null;
    if (opts.engineCredential) {
      const credential = await opts.engineCredential.getCredential();
      if (!credential.success) {
        log.error(
          "rivet proxy: engine credential unavailable, refusing request",
          {
            path: url.pathname,
            code: credential.error.code,
            status: credential.error.status,
          },
        );
        return deny(503, "engine_auth_unavailable");
      }
      if (credential.data.kind === "token") engineToken = credential.data.token;
    }

    if (route.kind === "http") {
      return passthroughHttp(
        req,
        target.path,
        target.search,
        clientIp,
        engineToken,
      );
    }

    // WS relay. Offered subprotocols are the rivet wire handshake (encoding,
    // conn params carrying the actor connection params) — forwarded as opaque
    // bytes, except browser-supplied rivet_token.* entries, which are dropped.
    const offered = stripTokenProtocols(
      req.headers.get("sec-websocket-protocol"),
    );
    const upgradeHeaders: Record<string, string> = {};
    if (offered.includes("rivet")) {
      upgradeHeaders["Sec-WebSocket-Protocol"] = "rivet";
    }
    const upgraded = relay.upgrade(
      req,
      server,
      {
        upstreamUrl: `${upstreamWs}${target.path}${target.search}`,
        protocols: offered,
        engineToken,
        origin,
        clientIp,
      },
      upgradeHeaders,
    );
    if (!upgraded) {
      return deny(404, "upgrade_failed");
    }
    return undefined;
  };

  return { handleRequest, websocket: relay.websocket };
}
