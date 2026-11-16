import { describe, expect, test } from "bun:test";
import { configureEntities, verifyPrincipal } from "@example/entities";
import { entityRoutes } from "./entity-routes.ts";
import { createRateLimiter } from "./rate-limit.ts";

configureEntities({ secret: "entity-routes-test" });

const origin = "http://localhost:5173";

function routes(limit = 60) {
  const app = entityRoutes({
    origins: [origin],
    clientAddress: (request) =>
      request.headers.get("x-test-address") ?? undefined,
    signInLimiter: createRateLimiter({ limit, windowMs: 60_000 }),
  });
  const signIn = (persona: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request("http://localhost/api/entities/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...headers },
        body: JSON.stringify({ persona }),
      }),
    );
  return { signIn };
}

describe("sign-in", () => {
  test("signs a verifiable, relative-expiry token for a known persona", async () => {
    const response = await routes().signIn("ada");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      token: string;
      expiresIn: number;
    };
    expect(body.expiresIn).toBe(3600);
    expect(verifyPrincipal(body.token)?.principal.sub).toBe("ada");
  });

  test("refuses unknown personas, including the reserved server id", async () => {
    const { signIn } = routes();
    for (const persona of ["system", "mallory", 42, null])
      expect((await signIn(persona)).status).toBe(400);
  });

  test("refuses foreign origins", async () => {
    const response = await routes().signIn("ada", {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });

  test("limits sign-ins per client address", async () => {
    const { signIn } = routes(2);
    const from = (address: string) => ({ "x-test-address": address });
    expect((await signIn("ada", from("10.0.0.1"))).status).toBe(200);
    expect((await signIn("ada", from("10.0.0.1"))).status).toBe(200);
    const limited = await signIn("ada", from("10.0.0.1"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address has its own budget.
    expect((await signIn("ada", from("10.0.0.2"))).status).toBe(200);
  });
});

describe("rate limiter", () => {
  test("a window resets after it ends", () => {
    let now = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 1000,
      now: () => now,
    });
    expect(limiter.hit("a").ok).toBe(true);
    expect(limiter.hit("a")).toEqual({ ok: false, retryAfter: 1 });
    now = 1000;
    expect(limiter.hit("a").ok).toBe(true);
  });
});
