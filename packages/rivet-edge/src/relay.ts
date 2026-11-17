/**
 * A bounded WebSocket relay: one Bun server socket in, one client socket to
 * an upstream out. The /rivet gateway uses it for the engine leg, and the web
 * service uses it to forward /rivet to the api service.
 *
 * Bounded FIFO buffers in both directions (a slow peer can never grow memory
 * without bound; over the cap both legs close 1013), frame order preserved,
 * close codes mirrored both ways, upstream errors mapped to 1011 so the
 * client's reconnect-with-backoff takes over.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { log as logger } from "@example/config";

/** Subprotocol prefix the engine reads its credential from. */
export const WS_PROTOCOL_TOKEN_PREFIX = "rivet_token.";

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

export interface SocketRelayOptions {
  maxBufferedBytes?: number;
  upstreamDialTimeoutMs?: number;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /** Log prefix. */
  label?: string;
}

/** What a route handler knows before the upgrade. */
export interface UpstreamDial {
  upstreamUrl: string;
  protocols: string[];
  engineToken?: string | null;
  origin: string | null;
  clientIp: string | null;
}

export interface SocketRelay {
  websocket: WebSocketHandler<WsConnData>;
  /**
   * Upgrade `req` and dial the upstream once the browser socket opens.
   * False when Bun refused the upgrade.
   */
  upgrade(
    req: Request,
    server: Server<WsConnData>,
    dial: UpstreamDial,
    headers?: Record<string, string>,
  ): boolean;
}

export function createSocketRelay(opts: SocketRelayOptions = {}): SocketRelay {
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const dialTimeoutMs =
    opts.upstreamDialTimeoutMs ?? DEFAULT_UPSTREAM_DIAL_TIMEOUT_MS;
  const log = opts.log ?? logger;
  const label = opts.label ?? "rivet proxy";

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
          log.warn(`${label}: upstream dial timeout`, {
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
        log.error(`${label}: upstream dial threw`, {
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
            log.warn(`${label}: browser-leg buffer cap exceeded, closing`, {
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
        log.warn(`${label}: upstream WS error`, {
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
        log.warn(`${label}: upstream-leg buffer cap exceeded, closing`, {
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

  const upgrade: SocketRelay["upgrade"] = (req, server, dial, headers) =>
    server.upgrade(req, {
      data: {
        ...dial,
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
      headers: headers ?? {},
    });

  return { websocket, upgrade };
}
