/**
 * Engine credential for the browser gateway proxy (Rivet 3.0 engines).
 *
 * Engine 3.0 authenticates EVERY `/gateway` request (pegboard-gateway
 * `routes.rs` prepare() → `auth::authenticate`). The proxy therefore attaches
 * an engine credential on the upstream leg only. This module mints that
 * credential: a namespace-scoped Rivet JWT from the engine's token API
 * (`POST /auth/tokens`, api-public-shim `tokens.rs`), authenticated with the
 * admin token (`RIVET_TOKEN`) the api already holds.
 *
 * Least privilege. The JWT carries exactly the grants the rivetkit browser
 * client's gateway traffic is authorized against (engine v3.0.0-preview.2):
 *
 *   - `actor_gateway` / any / [read, create]
 *       acquire.rs `authorize_read` (Read) reaches an existing actor;
 *       `CreateActor::authorize` (Create) is required before the gateway may
 *       create an actor from a name/key selector.
 *   - `actor` / any / [read, create]
 *       routes.rs prepare(): a query selector (`rvt-method`) is authorized as
 *       Actor Read (`get`) or Actor Create (`getOrCreate`) with no target id,
 *       so the grant target must be `any`.
 *
 * No update/delete/list, no `pool`/`node`/`namespace`/`datacenter`/`actor_kv`
 * grants, and `token`/`jwt` grants are un-mintable (auth-jwt grants.rs). A
 * leaked JWT can reach actor traffic in ONE namespace and nothing else; the
 * actor's own HMAC onBeforeConnect remains the authorization boundary.
 *
 * Lifetime: 2h (engine default 1h, max 24h — config/auth.rs). Refreshed in the
 * background once half the lifetime has elapsed, so any connection opened with
 * a cached token carries at least 1h of remaining validity.
 *
 * Handling rules:
 *   - single-flight: concurrent callers share one in-flight mint;
 *   - fail closed: a mint failure returns an error result (the proxy answers
 *     503) — the admin token is NEVER used as a fallback credential;
 *   - 2.x engines: `GET /health` reports `architecture: "v3"` only on 3.x (2.3.20
 *     omits it). Anything else has no JWT gateway auth, so the minter reports
 *     `none` (rechecked after 30 s) and the proxy sends no credential. A 2.x
 *     engine answers `/auth/tokens` with a Rivet-shaped 404, so the route
 *     cannot be used to tell the generations apart. Detected, not configured;
 *   - the admin token and minted JWT are never logged or returned to callers
 *     other than the proxy's upstream-leg injection.
 */
import { log as logger } from "@example/config";

/** Requested JWT lifetime in seconds (engine max is 24h). */
export const ENGINE_TOKEN_TTL_SECONDS = 2 * 60 * 60;
/** Refresh in the background once this fraction of the lifetime has elapsed. */
const REFRESH_AT_FRACTION = 0.5;
/** Treat a token as expired this long before the engine would. */
const EXPIRY_SAFETY_MS = 30_000;
/** After a failed mint, do not retry for this long (callers fail fast). */
const MINT_FAILURE_BACKOFF_MS = 5_000;
/** Recheck pre-3.0 engines this often. */
const UNSUPPORTED_RECHECK_MS = 30_000;
const MINT_TIMEOUT_MS = 5_000;
const TOKEN_SUBJECT = "app-gateway-proxy";

export type EngineTokenErrorCode =
  "mint_rejected" | "mint_unavailable" | "mint_malformed";

export interface EngineTokenError {
  code: EngineTokenErrorCode;
  /** HTTP status of the mint response when there was one. */
  status?: number;
  /** Engine error `group.code` when the engine returned a Rivet error body. */
  engineError?: string;
}

export type EngineCredential =
  | { kind: "token"; token: string }
  /** Engine predates JWT gateway auth: send no credential. */
  | { kind: "none" };

export type EngineTokenResult =
  | { success: true; data: EngineCredential }
  | { success: false; error: EngineTokenError };

export interface EngineCredentialProvider {
  getCredential(): Promise<EngineTokenResult>;
}

/** The grant set minted into the JWT. Exported so tests pin it. */
export const ENGINE_GATEWAY_GRANTS = [
  {
    resource: "actor_gateway",
    target: "any",
    operations: ["read", "create"],
  },
  {
    resource: "actor",
    target: "any",
    operations: ["read", "create"],
  },
] as const;

export interface EngineTokenMinterOptions {
  /** Bare engine base URL (RIVET_ENDPOINT). */
  upstreamHttp: string;
  /** Engine admin token (RIVET_TOKEN). Used only to call POST /auth/tokens. */
  adminToken: string;
  namespace: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Pick<typeof logger, "info" | "warn">;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
  refreshAtMs: number;
}

interface RivetErrorBody {
  group?: unknown;
  code?: unknown;
}

function engineErrorLabel(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { group, code } = body as RivetErrorBody;
  if (typeof group !== "string") return undefined;
  return typeof code === "string" ? `${group}.${code}` : group;
}

export function createEngineTokenMinter(
  opts: EngineTokenMinterOptions,
): EngineCredentialProvider {
  const base = opts.upstreamHttp.replace(/\/+$/, "");
  const ttl = opts.ttlSeconds ?? ENGINE_TOKEN_TTL_SECONDS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? logger;

  let current: CachedToken | null = null;
  let inflight: Promise<EngineTokenResult> | null = null;
  let v3Confirmed = false;
  let unsupportedUntil = 0;
  let failedUntil = 0;
  let lastError: EngineTokenError = { code: "mint_unavailable" };

  const fail = (error: EngineTokenError): EngineTokenResult => {
    lastError = error;
    failedUntil = now() + MINT_FAILURE_BACKOFF_MS;
    // Status + engine error label only — never the request, response body
    // text, or any token.
    log.warn("rivet engine token mint failed", {
      namespace: opts.namespace,
      code: error.code,
      status: error.status,
      engineError: error.engineError,
    });
    return { success: false, error };
  };

  /** True for a 3.x engine, false for 2.x, null when /health was unreachable. */
  const isV3Engine = async (): Promise<boolean | null> => {
    try {
      const res = await doFetch(`${base}/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { architecture?: unknown } | null;
      return body?.architecture === "v3";
    } catch {
      return null;
    }
  };

  const mint = async (): Promise<EngineTokenResult> => {
    if (!v3Confirmed) {
      const v3 = await isV3Engine();
      if (v3 === null) return fail({ code: "mint_unavailable" });
      if (!v3) {
        current = null;
        unsupportedUntil = now() + UNSUPPORTED_RECHECK_MS;
        log.info(
          "rivet engine is pre-3.0; gateway proxy sends no engine credential",
        );
        return { success: true, data: { kind: "none" } };
      }
      v3Confirmed = true;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}/auth/tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: opts.namespace,
          duration: ttl,
          subject: TOKEN_SUBJECT,
          grants: ENGINE_GATEWAY_GRANTS,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch {
      return fail({ code: "mint_unavailable" });
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      return fail({
        code: "mint_rejected",
        status: res.status,
        engineError: engineErrorLabel(body),
      });
    }

    const parsed = body as {
      token?: unknown;
      issued_ts?: unknown;
      expires_ts?: unknown;
    } | null;
    if (!parsed || typeof parsed.token !== "string" || parsed.token === "") {
      return fail({ code: "mint_malformed", status: res.status });
    }
    // Lifetime from the engine's own issued/expires pair, anchored on the
    // LOCAL clock so api/engine clock skew cannot mint an already-expired
    // token. Falls back to the requested ttl.
    const engineLifetimeMs =
      typeof parsed.issued_ts === "number" &&
      typeof parsed.expires_ts === "number" &&
      parsed.expires_ts > parsed.issued_ts
        ? parsed.expires_ts - parsed.issued_ts
        : ttl * 1000;
    const lifetimeMs = Math.min(engineLifetimeMs, ttl * 1000);
    const issuedAt = now();
    current = {
      token: parsed.token,
      expiresAtMs: issuedAt + lifetimeMs,
      refreshAtMs: issuedAt + lifetimeMs * REFRESH_AT_FRACTION,
    };
    failedUntil = 0;
    log.info("rivet engine gateway token minted", {
      namespace: opts.namespace,
      lifetimeSeconds: Math.round(lifetimeMs / 1000),
    });
    return { success: true, data: { kind: "token", token: parsed.token } };
  };

  const startMint = (): Promise<EngineTokenResult> => {
    if (inflight) return inflight;
    const p = mint().finally(() => {
      inflight = null;
    });
    inflight = p;
    return p;
  };

  return {
    async getCredential(): Promise<EngineTokenResult> {
      const t = now();
      if (unsupportedUntil > t) {
        return { success: true, data: { kind: "none" } };
      }
      if (current && t < current.expiresAtMs - EXPIRY_SAFETY_MS) {
        if (t >= current.refreshAtMs && failedUntil <= t) {
          // Background refresh: the current token is still good, keep serving it.
          void startMint();
        }
        return { success: true, data: { kind: "token", token: current.token } };
      }
      if (failedUntil > t) return { success: false, error: lastError };
      return startMint();
    },
  };
}
