import { UserError } from "rivetkit";
import {
  ENTITY_CLOSE_REASONS,
  ENTITY_ERRORS,
  type EntityConnParams,
  type Principal,
} from "./contracts.ts";
import {
  authorizeTransport,
  isSystem,
  verifyPrincipal,
  type Session,
} from "./principal.ts";

/**
 * Who is on each connection, the way Rivet recommends:
 *
 *   onBeforeConnect  verify the token; throwing rejects the socket
 *   onConnect        keep the session in `c.vars`, keyed by `conn.id`
 *   onDisconnect     forget it
 *   actions          `caller(c)` / `writer(c)` read it back
 *
 * Sessions live in `c.vars`, not in connection state: they are rebuilt from
 * the connection's own signed params whenever they are missing, so nothing
 * about a caller is ever persisted or trusted from storage.
 */

/** Writes one caller may burst into one actor. */
const WRITE_BURST = 30;
/** Writes per second a caller earns back. */
const WRITE_REFILL_PER_SECOND = 5;
/** Callers tracked per actor before full buckets are dropped. */
const MAX_WRITE_BUCKETS = 1_000;
/** setTimeout's ceiling. Tokens never live this long; clamp anyway. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface LiveSession extends Session {
  expiry?: ReturnType<typeof setTimeout>;
}

interface WriteBucket {
  tokens: number;
  at: number;
}

/** Per-wake memory every entity actor keeps. Return it from `createVars`. */
export interface EntityVars {
  sessions: Map<string, LiveSession>;
  writes: Map<string, WriteBucket>;
}

export function createEntityVars(): EntityVars {
  return { sessions: new Map(), writes: new Map() };
}

/** The slice of a Rivet connection these helpers use. */
export interface EntityConn {
  id: string;
  params: unknown;
  send(name: string, ...args: unknown[]): void;
  disconnect(reason?: string): Promise<void>;
}

/** Any context that can reach every open connection: actions and hooks. */
export interface PublishContext {
  vars: EntityVars;
  conns: Map<string, EntityConn>;
}

/** Any context with entity vars: actions, hooks, `canSubscribe`. */
export interface EntityContext {
  vars: EntityVars;
  /** Absent when a schedule or the inspector invokes an action. */
  conn?: EntityConn;
}

export function unauthenticated(message = "Sign in to continue."): UserError {
  return new UserError(message, { code: ENTITY_ERRORS.unauthenticated });
}

export function forbidden(
  message = "You do not have access to do that.",
): UserError {
  return new UserError(message, { code: ENTITY_ERRORS.forbidden });
}

function tokenOf(params: unknown): unknown {
  return params && typeof params === "object" && "principal" in params
    ? (params as EntityConnParams).principal
    : undefined;
}

/**
 * Use in `onBeforeConnect`. Runs the transport check, then verifies the
 * principal token. Throws to reject the socket before it exists.
 */
export function authenticate(
  c: { request?: Request },
  params: unknown,
): Session {
  authorizeTransport(c, params);
  const session = verifyPrincipal(tokenOf(params));
  if (!session) throw unauthenticated();
  return session;
}

function closeExpired(conn: EntityConn): Promise<void> {
  return conn
    .disconnect(ENTITY_CLOSE_REASONS.sessionExpired)
    .catch(() => undefined);
}

/**
 * Use in `onConnect`. Remembers the session and closes the socket the moment
 * its token expires. The client reconnects with a fresh token.
 */
export function trackSession(c: { vars: EntityVars }, conn: EntityConn): void {
  const session = verifyPrincipal(tokenOf(conn.params));
  // onBeforeConnect already verified it; an edge case like a token expiring
  // between the two hooks still closes the socket instead of trusting it.
  if (!session) {
    void closeExpired(conn);
    return;
  }
  forgetSession(c, conn);
  const live: LiveSession = { ...session };
  live.expiry = setTimeout(
    () => void closeExpired(conn),
    Math.min(Math.max(session.expiresAt - Date.now(), 0), MAX_TIMER_MS),
  );
  c.vars.sessions.set(conn.id, live);
}

/** Use in `onDisconnect`. */
export function forgetSession(
  c: { vars: EntityVars },
  conn: { id: string },
): void {
  const live = c.vars.sessions.get(conn.id);
  if (live?.expiry) clearTimeout(live.expiry);
  c.vars.sessions.delete(conn.id);
}

/**
 * The live principal on a connection, or null when the token is missing or
 * expired. A session missing from `c.vars` (an actor that woke with the
 * socket still open) is rebuilt from the connection's signed params.
 */
export function sessionPrincipal(
  c: { vars: EntityVars },
  conn: EntityConn,
): Principal | null {
  if (!c.vars.sessions.has(conn.id)) trackSession(c, conn);
  const live = c.vars.sessions.get(conn.id);
  if (!live) return null;
  if (live.expiresAt <= Date.now()) {
    forgetSession(c, conn);
    void closeExpired(conn);
    return null;
  }
  return live.principal;
}

/** Who is calling this action. Throws for a missing or expired session. */
export function caller(c: EntityContext): Principal {
  if (!c.conn) throw unauthenticated();
  const principal = sessionPrincipal(c, c.conn);
  if (!principal) throw unauthenticated("Your sign-in expired. Reconnecting.");
  return principal;
}

/**
 * The caller of an action that changes state. Each caller gets a small,
 * refilling write budget per actor, so one tab cannot flood an entity.
 * The server's own calls are never limited.
 */
export function writer(c: EntityContext): Principal {
  const principal = caller(c);
  if (!isSystem(principal)) spendWrite(c.vars, principal.sub);
  return principal;
}

/** Only the server, through `systemParams()`, may call this action. */
export function requireSystem(c: EntityContext): void {
  if (!isSystem(caller(c))) throw forbidden("Only the server can do that.");
}

function spendWrite(vars: EntityVars, sub: string): void {
  const now = Date.now();
  const bucket = vars.writes.get(sub) ?? { tokens: WRITE_BURST, at: now };
  bucket.tokens = Math.min(
    WRITE_BURST,
    bucket.tokens + ((now - bucket.at) / 1000) * WRITE_REFILL_PER_SECOND,
  );
  bucket.at = now;
  if (bucket.tokens < 1) {
    throw new UserError("Too many changes at once. Try again in a moment.", {
      code: ENTITY_ERRORS.rateLimited,
    });
  }
  bucket.tokens -= 1;
  vars.writes.set(sub, bucket);
  if (vars.writes.size > MAX_WRITE_BUCKETS) pruneBuckets(vars, now);
}

/** Drop callers whose budget has refilled: they would start full anyway. */
function pruneBuckets(vars: EntityVars, now: number): void {
  const refillMs = (WRITE_BURST / WRITE_REFILL_PER_SECOND) * 1000;
  for (const [sub, bucket] of vars.writes)
    if (now - bucket.at >= refillMs) vars.writes.delete(sub);
}

/**
 * A `broadcast` that reaches only connections allowed to read: the server,
 * and live sessions that pass `canRead`. `c.broadcast` would also reach a
 * member removed a moment ago and a socket whose token just expired. Use it
 * for every event an entity sends.
 */
/**
 * Shared actor options for the entity actors. They sleep after 5 minutes
 * without a connection instead of Rivet's 30 s, so ordinary back-and-forth
 * browsing never waits on a wake. Memory per idle actor is small.
 * https://rivet.dev/docs/actors/lifecycle
 */
export const ENTITY_OPTIONS = { sleepTimeout: 5 * 60_000 } as const;

export function publishTo(
  c: PublishContext,
  canRead: (principal: Principal) => boolean = () => true,
): (name: string, payload: unknown) => void {
  return (name, payload) => {
    for (const conn of c.conns.values()) {
      const principal = sessionPrincipal(c, conn);
      if (principal && (isSystem(principal) || canRead(principal)))
        conn.send(name, payload);
    }
  };
}
