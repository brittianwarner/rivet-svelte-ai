import { createHash, timingSafeEqual } from "node:crypto";
import { UserError } from "rivetkit";
import { actorToken } from "./env.ts";

const WEB_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

interface ConnectLike {
  request?: Request;
}

function tokenMatches(expected: string, provided: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

/**
 * Browser sockets must come from the web app.
 * When ACTOR_TOKEN is set, the connection params must carry the same token.
 * A missing Origin is allowed so the API process can call actors.
 */
export function authorizeConnection(c: ConnectLike, params: unknown): void {
  const origin = c.request?.headers.get("origin");
  if (origin && !WEB_ORIGINS.has(origin)) {
    throw new UserError("Origin not allowed", { code: "ORIGIN_NOT_ALLOWED" });
  }

  const expected = actorToken();
  if (!expected) return;

  const provided =
    params &&
    typeof params === "object" &&
    "token" in params &&
    typeof params.token === "string"
      ? params.token
      : "";

  if (!tokenMatches(expected, provided)) {
    throw new UserError("Connection was not authorized", {
      code: "AUTH_FORBIDDEN",
    });
  }
}

/** Params for server-side actor calls when the demo token is enabled. */
export function serverActorParams(): { token: string } | undefined {
  const token = actorToken();
  return token ? { token } : undefined;
}
