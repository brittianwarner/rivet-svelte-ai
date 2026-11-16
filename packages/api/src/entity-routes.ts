import { signPrincipal, type Principal } from "@example/entities";
import { Elysia } from "elysia";
import { readJson } from "./app.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";

/**
 * Demo sign-in for the organizations example.
 *
 * Picking a persona IS the sign-in: there is no password. That keeps the
 * example about entity actors, not about an identity provider. To ship this,
 * replace `/entities/sign-in` with your real login and keep the rest: the API
 * authenticates a person, signs a principal token, and the browser passes it
 * as `{ principal }` connection params. The actors verify it.
 */
export const PERSONAS: readonly Principal[] = [
  { sub: "ada", name: "Ada" },
  { sub: "grace", name: "Grace" },
  { sub: "linus", name: "Linus" },
];

const TOKEN_TTL_SECONDS = 60 * 60;
/** Sign-ins per client address per minute. A real login would also limit per account. */
const SIGN_INS_PER_MINUTE = 60;

export interface EntityRouteOptions {
  origins: string[];
  publicOrigin?: string;
  /**
   * The client's address, as the host derives it from the socket and its
   * trusted proxy. Requests without one share a single sign-in budget.
   */
  clientAddress?: (request: Request) => string | undefined;
  /** Override for tests. */
  signInLimiter?: RateLimiter;
}

export function entityRoutes(opts: EntityRouteOptions) {
  const limiter =
    opts.signInLimiter ??
    createRateLimiter({ limit: SIGN_INS_PER_MINUTE, windowMs: 60_000 });

  return new Elysia({ prefix: "/api" })
    .get("/entities/personas", () => ({ personas: PERSONAS }))
    .post(
      "/entities/sign-in",
      async ({ request, set }) => {
        set.headers["cache-control"] = "no-store";
        const origin = request.headers.get("origin");
        if (
          origin &&
          !opts.origins.includes(origin) &&
          origin !== opts.publicOrigin
        ) {
          set.status = 403;
          return { error: "origin_not_allowed" };
        }
        const allowed = limiter.hit(opts.clientAddress?.(request) ?? "unknown");
        if (!allowed.ok) {
          set.status = 429;
          set.headers["retry-after"] = String(allowed.retryAfter);
          return { error: "too_many_sign_ins", retryAfter: allowed.retryAfter };
        }
        const body = await readJson(request);
        if (!body.ok) {
          set.status = body.status;
          return { error: body.error };
        }
        const sub = (body.value as { persona?: unknown } | null)?.persona;
        const principal = PERSONAS.find((persona) => persona.sub === sub);
        if (!principal) {
          set.status = 400;
          return { error: "unknown_persona" };
        }
        return {
          principal,
          token: signPrincipal(principal, TOKEN_TTL_SECONDS),
          // Relative, so the browser's clock never has to agree with ours.
          expiresIn: TOKEN_TTL_SECONDS,
        };
      },
      { parse: "none" },
    );
}
