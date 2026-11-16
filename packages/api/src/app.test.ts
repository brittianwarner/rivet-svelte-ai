import { describe, expect, test } from "bun:test";
import { createApi, type ApiDependencies } from "./app.ts";

function api(overrides: Partial<ApiDependencies> = {}) {
  const calls: Array<[string, number]> = [];
  const app = createApi({
    origins: ["http://localhost:5173"],
    token: () => null,
    provider: () => ({ provider: "none", modelId: null }),
    ready: () => true,
    increment: async (name: string, by: number) => {
      calls.push([name, by]);
      return by;
    },
    ...overrides,
  });
  const request = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init));
  const json = async (path: string, init?: RequestInit) =>
    (await (await request(path, init)).json()) as Record<string, unknown>;
  return { app, calls, request, json };
}

describe("counter increment", () => {
  const { calls, request } = api();
  const post = (body: string, origin?: string) =>
    request("/api/counters/demo/increment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body,
    });

  test("validates before invoking actors, including malformed and oversized bodies", async () => {
    for (const body of [
      "{",
      "null",
      "[]",
      '{"by":"2"}',
      '{"by":0}',
      '{"by":101}',
      '{"by":1.5}',
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(
      (await post(JSON.stringify({ padding: "x".repeat(2000) }))).status,
    ).toBe(413);
    expect((await post('{"by":1}', "https://untrusted.example")).status).toBe(
      403,
    );
    expect(calls).toHaveLength(0);

    const response = await post('{"by":2}', "http://localhost:5173");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2 });
    expect(calls).toEqual([["demo", 2]]);
  });

  test("rejects names that are not actor keys", async () => {
    const response = await request("/api/counters/Not%20Valid/increment", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  test("a failing actor is a 502 without internals", async () => {
    const failing = api({
      increment: async () => {
        throw new Error("sensitive upstream detail");
      },
    });
    const response = await failing.request("/api/counters/demo/increment", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("sensitive");
  });
});

describe("client config", () => {
  test("points the browser at this origin's /rivet edge, never the engine", async () => {
    const { request } = api({ namespace: "starter" });
    const body = await (await request("/api/client-config")).json();
    expect(body).toEqual({
      rivetEndpoint: "http://localhost/rivet",
      rivetNamespace: "starter",
      actorToken: null,
    });
  });

  test("honors the edge's forwarded host and scheme", async () => {
    const { json } = api();
    const body = await json("/api/client-config", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example",
      },
    });
    expect(body.rivetEndpoint).toBe("https://app.example/rivet");
  });

  test("a configured public origin wins over request headers", async () => {
    const { request } = api({ publicOrigin: "https://site.example" });
    const response = await request("/api/client-config", {
      headers: { "x-forwarded-host": "evil.example" },
    });
    expect(
      ((await response.json()) as { rivetEndpoint: string }).rivetEndpoint,
    ).toBe("https://site.example/rivet");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("health", () => {
  test("liveness stays up while readiness waits for the runner", async () => {
    let ready = false;
    const { request } = api({ ready: () => ready });
    expect((await request("/api/health")).status).toBe(200);
    expect((await request("/api/health/actors")).status).toBe(503);
    ready = true;
    expect((await request("/api/health/actors")).status).toBe(200);
  });
});
