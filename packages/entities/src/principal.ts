import {
  createFileStore,
  fileStoreConfig,
  type FileStore,
} from "@example/files";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  LIMITS,
  isEntityId,
  type EntityConnParams,
  type Principal,
} from "./contracts.ts";

/**
 * Principal tokens: `<kind>.base64url(json).base64url(hmac)`.
 *
 * The API signs a `user` token after it has authenticated a person. Actors
 * sign short `system` tokens for calls to each other. Each kind has its own
 * key, derived from one secret, and the signature covers the kind, so a user
 * token can never pass as a system token, even if the user-signing path leaks.
 *
 * This is a teaching implementation. Production apps keep the same shape and
 * swap `verifyPrincipal` for their identity provider's JWT check.
 */

export const SYSTEM: Principal = { sub: "system", name: "System" };

/** How long an actor-to-actor token lives. Each call signs a fresh one. */
const SYSTEM_TTL_SECONDS = 60;
/** Longer tokens are refused before any parsing. */
const MAX_TOKEN_LENGTH = 2048;

type TokenKind = "user" | "system";

interface TokenBody extends Principal {
  exp: number;
}

/** A verified token: who is calling, and until when. */
export interface Session {
  principal: Principal;
  /** Epoch milliseconds. The actor closes the socket at this moment. */
  expiresAt: number;
}

interface EntityConfig {
  keys: Record<TokenKind, Buffer>;
  /** Where entity actors keep file bytes (exports). Default: from FILES_*. */
  files: FileStore | null;
  /** Extra transport check, such as the starter's origin and demo-token gate. */
  authorizeTransport?: (c: { request?: Request }, params: unknown) => void;
  /** How long a finished export can be downloaded. */
  exportTtlMs: number;
}

/** `ENTITY_EXPORT_TTL_SECONDS`, or one hour. */
function defaultExportTtlMs(): number {
  const seconds = Number(process.env.ENTITY_EXPORT_TTL_SECONDS);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
}

let config: EntityConfig | null = null;

/** One secret, one key per token kind. Rotating the secret rotates both. */
function deriveKeys(secret: string): Record<TokenKind, Buffer> {
  const derive = (kind: TokenKind) =>
    createHmac("sha256", secret).update(`rivet-entities/${kind}`).digest();
  return { user: derive("user"), system: derive("system") };
}

/**
 * Configure once, before the registry starts.
 * Without a secret, a random per-process secret is used: tokens then stop
 * working after a restart, which is fine locally and wrong in production.
 */
export function configureEntities(
  next: {
    secret?: string;
    authorizeTransport?: EntityConfig["authorizeTransport"];
    /** Default: `ENTITY_EXPORT_TTL_SECONDS`, or one hour. */
    exportTtlMs?: number;
    /** Default: the store FILES_* describes (`@example/files`). */
    files?: FileStore;
  } = {},
): void {
  const secret = next.secret?.trim();
  config = {
    keys:
      secret || !config
        ? deriveKeys(secret || randomBytes(32).toString("hex"))
        : config.keys,
    authorizeTransport: next.authorizeTransport ?? config?.authorizeTransport,
    exportTtlMs:
      next.exportTtlMs ?? config?.exportTtlMs ?? defaultExportTtlMs(),
    files: next.files ?? config?.files ?? null,
  };
}

/** The file store entity actors write to. Configured, else from FILES_*. */
export function entityFiles(): FileStore {
  const entry = current();
  entry.files ??= createFileStore(fileStoreConfig());
  return entry.files;
}

/** How long a finished export can be downloaded. */
export function exportTtlMs(): number {
  return current().exportTtlMs;
}

function current(): EntityConfig {
  if (!config) configureEntities({ secret: process.env.ENTITY_SECRET });
  return config!;
}

/** Runs the transport check configured by the host app, if any. */
export function authorizeTransport(
  c: { request?: Request },
  params: unknown,
): void {
  current().authorizeTransport?.(c, params);
}

const encode = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

function signature(kind: TokenKind, signed: string): Buffer {
  return createHmac("sha256", current().keys[kind]).update(signed).digest();
}

function sign(
  kind: TokenKind,
  principal: Principal,
  ttlSeconds: number,
): string {
  const body: TokenBody = {
    sub: principal.sub,
    name: principal.name,
    exp: Date.now() + ttlSeconds * 1000,
  };
  const signed = `${kind}.${encode(JSON.stringify(body))}`;
  return `${signed}.${encode(signature(kind, signed))}`;
}

/**
 * Sign a person's token. Call this only after your own sign-in has
 * authenticated them. Refuses reserved and malformed ids, so no user token
 * can name the server.
 */
export function signPrincipal(principal: Principal, ttlSeconds = 3600): string {
  if (!isEntityId(principal.sub))
    throw new Error(`Cannot sign a token for "${principal.sub}".`);
  return sign("user", principal, ttlSeconds);
}

/** Params for actor-to-actor calls. Never send these to a browser. */
export function systemParams(): EntityConnParams {
  return { principal: sign("system", SYSTEM, SYSTEM_TTL_SECONDS) };
}

/** The session in a token, or null for a missing, forged, or expired one. */
export function verifyPrincipal(token: unknown): Session | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [kind, payload, sig] = parts as [string, string, string];
  if (kind !== "user" && kind !== "system") return null;

  // Check the signature before reading anything the token claims.
  const expected = signature(kind, `${kind}.${payload}`);
  const provided = Buffer.from(sig, "base64url");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    return null;

  let body: Partial<TokenBody>;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof body.exp !== "number" || body.exp <= Date.now()) return null;
  if (typeof body.name !== "string" || body.name.length > LIMITS.name)
    return null;
  const valid =
    kind === "system" ? body.sub === SYSTEM.sub : isEntityId(body.sub);
  if (!valid) return null;
  return {
    principal: { sub: body.sub as string, name: body.name },
    expiresAt: body.exp,
  };
}

export function isSystem(principal: Principal): boolean {
  return principal.sub === SYSTEM.sub;
}
