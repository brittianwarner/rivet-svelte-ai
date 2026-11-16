/**
 * Engine JWT minter: request shape, caching, single-flight, background refresh,
 * fail-closed behaviour, 2.x engine detection via /health, and token redaction in logs.
 */
import { describe, expect, test } from "bun:test";
import {
  ENGINE_GATEWAY_GRANTS,
  ENGINE_TOKEN_TTL_SECONDS,
  createEngineTokenMinter,
} from "./engine-token.ts";

const ADMIN = "admin-secret-value";
const JWT_A = "jwt.a.signature";
const JWT_B = "jwt.b.signature";

interface MintCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const V3_HEALTH = () =>
  Response.json({ architecture: "v3", runtime: "engine", status: "ok" });

function harness(
  respond: (n: number) => Response | Promise<Response> | Error,
  health: () => Response | Error = V3_HEALTH,
) {
  const calls: MintCall[] = [];
  const healthCalls: string[] = [];
  const logs: unknown[] = [];
  const clock = { t: 1_000_000 };
  const log = {
    info: (...a: unknown[]) => void logs.push(a),
    warn: (...a: unknown[]) => void logs.push(a),
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/health")) {
      healthCalls.push(url);
      const h = health();
      if (h instanceof Error) throw h;
      return h;
    }
    calls.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    });
    const r = respond(calls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const minter = createEngineTokenMinter({
    upstreamHttp: "http://engine.internal:6420/",
    adminToken: ADMIN,
    namespace: "app-prod",
    fetchImpl,
    now: () => clock.t,
    log: log as never,
  });
  return { minter, calls, healthCalls, logs, clock };
}

const ok = (token: string, ttl = ENGINE_TOKEN_TTL_SECONDS) =>
  Response.json({
    token,
    issued_ts: 5_000,
    expires_ts: 5_000 + ttl * 1000,
  });

describe("createEngineTokenMinter", () => {
  test("mints a least-privilege namespace JWT with the admin token", async () => {
    const h = harness(() => ok(JWT_A));
    const r = await h.minter.getCredential();
    expect(r).toEqual({ success: true, data: { kind: "token", token: JWT_A } });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.url).toBe("http://engine.internal:6420/auth/tokens");
    expect(call.headers.get("authorization")).toBe(`Bearer ${ADMIN}`);
    expect(call.body).toEqual({
      namespace: "app-prod",
      duration: ENGINE_TOKEN_TTL_SECONDS,
      subject: "app-gateway-proxy",
      grants: ENGINE_GATEWAY_GRANTS,
    });
    // Pin the privilege set: gateway + actor read/create, nothing else.
    expect(
      ENGINE_GATEWAY_GRANTS.map((g) => [
        g.resource,
        g.target,
        [...g.operations],
      ]),
    ).toEqual([
      ["actor_gateway", "any", ["read", "create"]],
      ["actor", "any", ["read", "create"]],
    ]);
  });

  test("caches the token and does not re-mint before the refresh point", async () => {
    const h = harness(() => ok(JWT_A));
    await h.minter.getCredential();
    h.clock.t += 60 * 60 * 1000 - 1000; // just under 50% of 2h
    await h.minter.getCredential();
    expect(h.calls).toHaveLength(1);
  });

  test("single-flight: concurrent callers share one mint", async () => {
    const h = harness(
      () =>
        new Promise<Response>((r) =>
          setTimeout(() => r(ok(JWT_A)), 20),
        ) as never,
    );
    const results = await Promise.all(
      Array.from({ length: 25 }, () => h.minter.getCredential()),
    );
    expect(h.calls).toHaveLength(1);
    for (const r of results) {
      expect(r).toEqual({
        success: true,
        data: { kind: "token", token: JWT_A },
      });
    }
  });

  test("refreshes in the background past 50% and keeps serving the old token", async () => {
    let n = 0;
    const h = harness(() => ok(++n === 1 ? JWT_A : JWT_B));
    await h.minter.getCredential();
    h.clock.t += 61 * 60 * 1000;
    const during = await h.minter.getCredential();
    expect(during).toEqual({
      success: true,
      data: { kind: "token", token: JWT_A },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls).toHaveLength(2);
    // Several concurrent calls during refresh do not start more mints.
    const after = await h.minter.getCredential();
    expect(after).toEqual({
      success: true,
      data: { kind: "token", token: JWT_B },
    });
    expect(h.calls).toHaveLength(2);
  });

  test("expired token is never served; re-mints before returning", async () => {
    let n = 0;
    const h = harness(() => ok(++n === 1 ? JWT_A : JWT_B));
    await h.minter.getCredential();
    h.clock.t += ENGINE_TOKEN_TTL_SECONDS * 1000; // past expiry
    const r = await h.minter.getCredential();
    expect(r).toEqual({ success: true, data: { kind: "token", token: JWT_B } });
  });

  test("anchors lifetime on the local clock (engine clock skew is ignored)", async () => {
    // Engine reports timestamps far in the future; lifetime is still the delta.
    const h = harness(() =>
      Response.json({
        token: JWT_A,
        issued_ts: 9_000_000_000_000,
        expires_ts: 9_000_000_000_000 + ENGINE_TOKEN_TTL_SECONDS * 1000,
      }),
    );
    await h.minter.getCredential();
    h.clock.t += ENGINE_TOKEN_TTL_SECONDS * 1000; // local expiry
    await h.minter.getCredential();
    expect(h.calls).toHaveLength(2);
  });

  test("fails closed on rejection: error result, never the admin token", async () => {
    const h = harness(() =>
      Response.json(
        { group: "auth", code: "invalid_token", message: "nope" },
        { status: 401 },
      ),
    );
    const r = await h.minter.getCredential();
    expect(r).toEqual({
      success: false,
      error: {
        code: "mint_rejected",
        status: 401,
        engineError: "auth.invalid_token",
      },
    });
    // Backoff: an immediate retry fails fast without hammering the engine.
    const r2 = await h.minter.getCredential();
    expect(r2.success).toBe(false);
    expect(h.calls).toHaveLength(1);
    // After the backoff window it tries again and can recover.
    h.clock.t += 6000;
    const r3 = await h.minter.getCredential();
    expect(r3.success).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  test("fails closed on network error and malformed responses", async () => {
    const net = harness(() => new Error("ECONNREFUSED"));
    expect(await net.minter.getCredential()).toEqual({
      success: false,
      error: { code: "mint_unavailable" },
    });
    const bad = harness(() => Response.json({ nope: true }));
    expect(await bad.minter.getCredential()).toEqual({
      success: false,
      error: { code: "mint_malformed", status: 200 },
    });
  });

  test("a namespace-not-found 404 (Rivet error body) is a failure, not 'no engine auth'", async () => {
    const h = harness(() =>
      Response.json({ group: "namespace", code: "not_found" }, { status: 404 }),
    );
    const r = await h.minter.getCredential();
    expect(r.success).toBe(false);
  });

  test("2.x engine (no architecture in /health) yields 'none' without minting, rechecked after 30 seconds", async () => {
    // A 2.x engine answers /auth/tokens with a Rivet-shaped 404, so /health is
    // the only discriminator.
    const h = harness(
      () => Response.json({ group: "api", code: "not_found" }, { status: 404 }),
      () =>
        Response.json({ runtime: "engine", status: "ok", version: "2.3.20" }),
    );
    const r = await h.minter.getCredential();
    expect(r).toEqual({ success: true, data: { kind: "none" } });
    await h.minter.getCredential();
    expect(h.healthCalls).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
    h.clock.t += 30_000 + 1;
    await h.minter.getCredential();
    expect(h.healthCalls).toHaveLength(2);
    expect(h.calls).toHaveLength(0);
  });

  test("an unreachable /health fails closed instead of assuming a 2.x engine", async () => {
    const h = harness(
      () => ok(JWT_A),
      () => new Error("ECONNREFUSED"),
    );
    expect(await h.minter.getCredential()).toEqual({
      success: false,
      error: { code: "mint_unavailable" },
    });
    expect(h.calls).toHaveLength(0);
  });

  test("a 3.x engine is confirmed once, not on every refresh", async () => {
    let n = 0;
    const h = harness(() => ok(++n === 1 ? JWT_A : JWT_B));
    await h.minter.getCredential();
    h.clock.t += (ENGINE_TOKEN_TTL_SECONDS * 1000) / 2 + 1;
    await h.minter.getCredential();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.healthCalls).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
  });

  test("never logs the admin token or a minted JWT", async () => {
    const good = harness(() => ok(JWT_A));
    await good.minter.getCredential();
    const bad = harness(() => new Response("x", { status: 500 }));
    await bad.minter.getCredential();
    const net = harness(() => new Error(`connect failed ${ADMIN}`));
    await net.minter.getCredential();
    const dump = JSON.stringify([good.logs, bad.logs, net.logs]);
    expect(dump).not.toContain(ADMIN);
    expect(dump).not.toContain(JWT_A);
    expect(good.logs.length + bad.logs.length).toBeGreaterThan(0);
  });
});
