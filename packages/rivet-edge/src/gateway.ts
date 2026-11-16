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
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { isIP } from "node:net";
import { log as logger } from "@example/config";
import type { EngineCredentialProvider } from "./engine-token.ts";

// ---- Tunables ----------------------------------------------------------------

/** Start queueing for a peer above this buffered amount (one max-size rivet message). */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Resume flushing to a peer below this buffered amount. */
const LOW_WATER_BYTES = 1 * 1024 * 1024;
/** Hard per-connection buffer cap (both queues combined) — exceeding closes the socket. */
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Rivet client frames share the same explicit ceiling as the relay buffer. */
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Upstream WS dial deadline. */
const DEFAULT_UPSTREAM_DIAL_TIMEOUT_MS = 10_000;
/** Upstream browser-style WebSocket has no drain event — poll cadence while flushing. */
const UPSTREAM_DRAIN_POLL_MS = 25;
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

const WS_PROTOCOL_TOKEN_PREFIX = "rivet_token.";

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

/**
 * Cap a WebSocket close reason at the protocol's 123 UTF-8 BYTE limit.
 * `.slice(0, 123)` counts UTF-16 code units — multibyte content can pass it
 * at up to 3× the byte limit, which byte-truncates mid-character on the Bun
 * server leg (client sees 1007 "invalid UTF8" with NO reason) and throws a
 * SyntaxError on the client-WebSocket upstream leg (verified Bun 1.4.0).
 * Encode → cap → decode, dropping any partial trailing sequence.
 */
export function capWsCloseReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length <= 123) return reason;
  return new TextDecoder().decode(bytes.subarray(0, 123)).replace(/�+$/, "");
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

// ---- Relay -------------------------------------------------------------------

/** Per-connection relay state (Bun.serve websocket `data`). */
export interface WsConnData {
  upstreamUrl: string;
  protocols: string[];
  /** Proxy-minted engine JWT, appended to the upstream subprotocols on dial. Never logged. */
  engineToken?: string | null;
  origin: string | null;
  /** Trusted client IP stamped as X-Forwarded-For on the upstream dial. */
  clientIp: string | null;
  upstream: WebSocket | null;
  upstreamOpen: boolean;
  /** Browser → upstream frames held while the upstream dial is pending or backpressured. */
  downQueue: Array<string | Uint8Array<ArrayBuffer>>;
  downQueuedBytes: number;
  /** Upstream → browser frames held while the browser leg is backpressured. */
  upQueue: Array<string | Uint8Array>;
  upQueuedBytes: number;
  closed: boolean;
  dialTimer: ReturnType<typeof setTimeout> | null;
  drainTimer: ReturnType<typeof setInterval> | null;
}

function frameBytes(payload: string | Uint8Array): number {
  return typeof payload === "string"
    ? Buffer.byteLength(payload)
    : payload.byteLength;
}

function totalQueuedBytes(d: WsConnData): number {
  return d.downQueuedBytes + d.upQueuedBytes;
}

function isSendableCloseCode(code: number): boolean {
  return (
    (code >= 1000 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function normalizedCloseCode(code: number, fallback: 1001 | 1011): number {
  return isSendableCloseCode(code) ? code : fallback;
}

/**
 * Abort a Bun client WebSocket after graceful close rejects. TypeScript's DOM
 * `WebSocket` declaration wins for the global constructor in this package,
 * so describe Bun's runtime-only `terminate()` extension at this narrow seam.
 */
function terminateUpstream(socket: WebSocket | null): void {
  (
    socket as
      | (WebSocket & {
          terminate(): void;
        })
      | null
  )?.terminate();
}

function canSendUpstreamFrame(
  upstream: WebSocket,
  payload: string | Uint8Array,
  maxBuffered: number,
): boolean {
  const buffered = upstream.bufferedAmount;
  return (
    buffered <= HIGH_WATER_BYTES &&
    buffered + frameBytes(payload) <= maxBuffered
  );
}

function wouldExceedUpstreamBudget(
  d: WsConnData,
  payload: string | Uint8Array,
  maxBuffered: number,
): boolean {
  return (
    (d.upstream?.bufferedAmount ?? 0) +
      totalQueuedBytes(d) +
      frameBytes(payload) >
    maxBuffered
  );
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
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const dialTimeoutMs =
    opts.upstreamDialTimeoutMs ?? DEFAULT_UPSTREAM_DIAL_TIMEOUT_MS;
  const log = opts.log ?? logger;
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

  const closeBoth = (
    ws: ServerWebSocket<WsConnData>,
    code: number,
    reason: string,
  ): void => {
    const d = ws.data;
    if (d.closed) return;
    d.closed = true;
    if (d.dialTimer) clearTimeout(d.dialTimer);
    if (d.drainTimer) clearInterval(d.drainTimer);
    const capped = capWsCloseReason(reason);
    try {
      ws.close(code, capped);
    } catch {
      /* already closed */
    }
    try {
      d.upstream?.close(code, capped);
    } catch {
      // `WebSocket.close` rejects reserved/invalid close codes. Internal
      // callers currently use valid codes, but terminate guarantees the
      // engine leg cannot leak if that invariant ever regresses.
      terminateUpstream(d.upstream);
    }
  };

  const websocket: WebSocketHandler<WsConnData> = {
    // Long-lived actor sockets: ride above Bun's 120s default. Rivet traffic
    // (presence heartbeats ~30s, engine pings) keeps real connections warm;
    // this is the ceiling for genuinely idle tabs, not the mechanism.
    idleTimeout: 960,
    // Keep Bun's native socket buffer and the relay's userland queues under
    // the same hard ceiling. `close` mirrors the failure to the upstream leg.
    maxPayloadLength: DEFAULT_MAX_PAYLOAD_BYTES,
    backpressureLimit: maxBuffered,
    closeOnBackpressureLimit: true,
    sendPings: true,
    // Activity sockets carry tiny revision doorbells. Compression adds CPU
    // and per-connection state without reducing the authoritative HTTP read.
    perMessageDeflate: false,

    open(ws) {
      const d = ws.data;
      d.dialTimer = setTimeout(() => {
        if (!d.upstreamOpen) {
          log.warn("rivet proxy: upstream dial timeout", {
            url: d.upstreamUrl,
          });
          closeBoth(ws, 1011, "upstream dial timeout");
        }
      }, dialTimeoutMs);

      let upstream: WebSocket;
      try {
        // Bun's client WebSocket supports custom headers (Origin forwarding
        // so the actor-level CORS guard sees the browser's real origin) via
        // a nonstandard options bag the DOM lib types don't model.
        const WsClient = WebSocket as unknown as new (
          url: string,
          options: {
            protocols: string[];
            headers: Record<string, string>;
            perMessageDeflate: boolean;
          },
        ) => WebSocket;
        const dialHeaders: Record<string, string> = {};
        if (d.origin) dialHeaders.Origin = d.origin;
        // Per-client Guard rate-limit bucket — the bare dial previously made
        // every relayed browser socket count against the api host's single
        // IP. See deriveTrustedClientIp.
        if (d.clientIp) dialHeaders["X-Forwarded-For"] = d.clientIp;
        upstream = new WsClient(d.upstreamUrl, {
          protocols: d.engineToken
            ? [...d.protocols, `${WS_PROTOCOL_TOKEN_PREFIX}${d.engineToken}`]
            : d.protocols,
          headers: dialHeaders,
          // Rivet control/event frames are small; do not negotiate compression
          // on the private engine leg either.
          perMessageDeflate: false,
        });
      } catch (err) {
        log.error("rivet proxy: upstream dial threw", {
          error: err instanceof Error ? err.message : String(err),
        });
        closeBoth(ws, 1011, "upstream dial failed");
        return;
      }
      d.upstream = upstream;
      upstream.binaryType = "arraybuffer";

      upstream.addEventListener("open", () => {
        d.upstreamOpen = true;
        if (d.dialTimer) clearTimeout(d.dialTimer);
        d.dialTimer = null;
        // Flush anything the browser sent while the dial was in flight.
        while (d.downQueue.length > 0 && !d.closed) {
          const payload = d.downQueue[0]!;
          if (!canSendUpstreamFrame(upstream, payload, maxBuffered)) break;
          d.downQueue.shift();
          d.downQueuedBytes -= frameBytes(payload);
          upstream.send(payload);
        }
        if (d.downQueue.length === 0) d.downQueuedBytes = 0;
      });

      upstream.addEventListener("message", (event) => {
        if (d.closed) return;
        const data = event.data as string | ArrayBuffer;
        const payload = typeof data === "string" ? data : new Uint8Array(data);
        // Once a frame is queued, later frames must queue behind it even if
        // the native buffer becomes writable before Bun invokes `drain`.
        // Rivet's wire protocol is ordered; bypassing upQueue corrupts it.
        if (d.upQueue.length > 0 || ws.getBufferedAmount() > HIGH_WATER_BYTES) {
          const size = frameBytes(payload);
          if (totalQueuedBytes(d) + size > maxBuffered) {
            log.warn("rivet proxy: browser-leg buffer cap exceeded, closing", {
              queuedBytes: totalQueuedBytes(d),
            });
            closeBoth(ws, 1013, "backpressure limit");
            return;
          }
          d.upQueue.push(payload);
          d.upQueuedBytes += size;
          return;
        }
        const sent = ws.send(payload);
        if (sent === 0) {
          closeBoth(ws, 1011, "browser send failed");
        }
      });

      upstream.addEventListener("close", (event) => {
        if (d.closed) return;
        d.closed = true;
        if (d.dialTimer) clearTimeout(d.dialTimer);
        if (d.drainTimer) clearInterval(d.drainTimer);
        try {
          // Mirror the engine's close so the client's structured reconnect
          // logic sees the real reason (engine redeploy, etc.). Bun 1.4 keeps
          // standard close codes and the reason intact across the client leg.
          ws.close(
            normalizedCloseCode(event.code, 1011),
            event.reason || "upstream closed",
          );
        } catch {
          /* already closed */
        }
      });

      upstream.addEventListener("error", (event) => {
        // A guard-rejected upgrade (HTTP 429 before any WS close frame)
        // lands here — carry whatever detail Bun surfaces so a rate-limit
        // rejection is distinguishable from an engine outage in both the
        // log and the browser-visible close reason. (An upgrade the engine
        // ACCEPTS then closes with "guard.rate_limit#…" takes the close
        // handler above instead, which already mirrors the reason.)
        const detail =
          (event as { message?: unknown }).message ??
          (event as { error?: { message?: unknown } }).error?.message;
        const message = typeof detail === "string" ? detail : "";
        log.warn("rivet proxy: upstream WS error", {
          url: d.upstreamUrl,
          error: message || undefined,
        });
        // closeBoth byte-caps the reason to the WS 123-byte limit.
        closeBoth(
          ws,
          1011,
          message ? `upstream error: ${message}` : "upstream error",
        );
      });
    },

    message(ws, message) {
      const d = ws.data;
      if (d.closed) return;
      const payload = message;
      const upstream = d.upstream;
      if (
        d.upstreamOpen &&
        upstream &&
        d.downQueue.length === 0 &&
        canSendUpstreamFrame(upstream, payload, maxBuffered)
      ) {
        upstream.send(payload);
        return;
      }
      const size = frameBytes(payload);
      if (wouldExceedUpstreamBudget(d, payload, maxBuffered)) {
        log.warn("rivet proxy: upstream-leg buffer cap exceeded, closing", {
          bufferedBytes:
            (d.upstream?.bufferedAmount ?? 0) + totalQueuedBytes(d),
        });
        closeBoth(ws, 1013, "backpressure limit");
        return;
      }
      d.downQueue.push(payload);
      d.downQueuedBytes += size;
      // Browser-style WebSocket has no drain event — poll bufferedAmount and
      // flush when the upstream catches up.
      if (!d.drainTimer) {
        d.drainTimer = setInterval(() => {
          if (d.closed || !d.upstreamOpen || !d.upstream) return;
          if (d.upstream.bufferedAmount > LOW_WATER_BYTES) return;
          while (d.downQueue.length > 0) {
            const queued = d.downQueue[0]!;
            if (!canSendUpstreamFrame(d.upstream, queued, maxBuffered)) break;
            d.downQueue.shift();
            d.downQueuedBytes -= frameBytes(queued);
            d.upstream.send(queued);
          }
          if (d.downQueue.length === 0) {
            d.downQueuedBytes = 0;
            if (d.drainTimer) clearInterval(d.drainTimer);
            d.drainTimer = null;
          }
        }, UPSTREAM_DRAIN_POLL_MS);
      }
    },

    close(ws, code, reason) {
      const d = ws.data;
      if (d.closed) return;
      d.closed = true;
      if (d.dialTimer) clearTimeout(d.dialTimer);
      if (d.drainTimer) clearInterval(d.drainTimer);
      try {
        // 1005/1006/1015 are receive-only status codes. An abrupt browser
        // disappearance must still tear down the engine leg, so normalize it
        // to Going Away rather than passing an invalid code to Bun's client.
        d.upstream?.close(
          normalizedCloseCode(code, 1001),
          capWsCloseReason(reason || "client closed"),
        );
      } catch {
        terminateUpstream(d.upstream);
      }
    },

    // Bun server leg drained below its watermark → flush held upstream frames.
    drain(ws) {
      const d = ws.data;
      if (d.closed) return;
      // Cork batches a burst of queued frames into one native write cycle.
      ws.cork(() => {
        while (
          d.upQueue.length > 0 &&
          ws.getBufferedAmount() <= LOW_WATER_BYTES
        ) {
          const payload = d.upQueue.shift() as string | Uint8Array;
          d.upQueuedBytes -= frameBytes(payload);
          const sent = ws.send(payload);
          if (sent === 0) {
            closeBoth(ws, 1011, "browser send failed");
            return;
          }
          if (sent === -1) break;
        }
      });
      if (d.upQueue.length === 0) d.upQueuedBytes = 0;
    },
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
    const upgraded = server.upgrade(req, {
      data: {
        upstreamUrl: `${upstreamWs}${target.path}${target.search}`,
        protocols: offered,
        engineToken,
        origin,
        clientIp,
        upstream: null,
        upstreamOpen: false,
        downQueue: [],
        downQueuedBytes: 0,
        upQueue: [],
        upQueuedBytes: 0,
        closed: false,
        dialTimer: null,
        drainTimer: null,
      },
      headers: upgradeHeaders,
    });
    if (!upgraded) {
      return deny(404, "upgrade_failed");
    }
    return undefined;
  };

  return { handleRequest, websocket };
}
