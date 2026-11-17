/**
 * The web-to-api forwarder against a recording upstream: HTTP passthrough,
 * client identity, failover across addresses, and socket relay.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createForwarder, createUpstreamPool } from "./forwarder.ts";
import type { WsConnData } from "./relay.ts";

const quietLog = { info() {}, warn() {}, error() {} };

interface Seen {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const seen: Seen[] = [];
const upstream = Bun.serve<{ protocol: string | null }>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req, {
        data: { protocol: req.headers.get("sec-websocket-protocol") },
        headers: { "Sec-WebSocket-Protocol": "rivet" },
      });
      return ok ? undefined : new Response("no", { status: 400 });
    }
    seen.push({
      path: url.pathname + url.search,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    });
    return new Response("from api", {
      status: url.pathname === "/api/missing" ? 404 : 200,
      headers: { "x-upstream": "yes", "cache-control": "no-store" },
    });
  },
  websocket: {
    open(ws) {
      ws.send(`hello ${ws.data.protocol}`);
    },
    message(ws, message) {
      ws.send(`echo:${message}`);
    },
  },
});

const forwarder = createForwarder({
  upstream: `http://127.0.0.1:${upstream.port}`,
  log: quietLog,
});
const web = Bun.serve<WsConnData>({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/*": (req: Request, srv: Bun.Server<WsConnData>) =>
      forwarder.handle(req, srv),
    "/rivet/*": (req: Request, srv: Bun.Server<WsConnData>) =>
      forwarder.handle(req, srv),
  },
  fetch: () => new Response("page"),
  websocket: forwarder.websocket,
});
const origin = `http://127.0.0.1:${web.port}`;

afterAll(() => {
  web.stop(true);
  upstream.stop(true);
});

describe("http", () => {
  test("forwards method, path, query, body and response", async () => {
    const response = await fetch(`${origin}/api/things?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://site" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from api");
    expect(response.headers.get("x-upstream")).toBe("yes");
    const last = seen.at(-1)!;
    expect(last).toMatchObject({
      path: "/api/things?x=1",
      method: "POST",
      body: '{"a":1}',
    });
    expect(last.headers.origin).toBe("https://site");
    expect(last.headers["content-type"]).toBe("application/json");
  });

  test("passes statuses through", async () => {
    const response = await fetch(`${origin}/api/missing`);
    expect(response.status).toBe(404);
  });

  test("replaces a forged X-Forwarded-For with the trusted client address", async () => {
    await fetch(`${origin}/api/who`, {
      headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.9" },
    });
    // The last entry is what the nearest trusted hop appended.
    expect(seen.at(-1)!.headers["x-forwarded-for"]).toBe("10.0.0.9");
    await fetch(`${origin}/api/who`);
    expect(seen.at(-1)!.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  test("tells the api the public host and scheme", async () => {
    await fetch(`${origin}/api/who`, {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "site.dev" },
    });
    const last = seen.at(-1)!;
    expect(last.headers["x-forwarded-proto"]).toBe("https");
    expect(last.headers["x-forwarded-host"]).toBe("site.dev");
  });

  test("an unreachable api is a 502", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = dead.port;
    dead.stop(true);
    const lonely = createForwarder({
      upstream: `http://127.0.0.1:${port}`,
      log: quietLog,
    });
    const server = Bun.serve<WsConnData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => lonely.handle(req, srv) as Promise<Response>,
      websocket: lonely.websocket,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/x`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "api_unreachable" });
    } finally {
      server.stop(true);
    }
  });
});

describe("upstream pool", () => {
  test("rotates across every address of the name", async () => {
    const pool = createUpstreamPool("http://api.internal:8080", async () => [
      "fd00::1",
      "fd00::2",
    ]);
    const picks = [await pool.next(), await pool.next(), await pool.next()];
    expect(new Set(picks)).toEqual(
      new Set(["http://[fd00::1]:8080", "http://[fd00::2]:8080"]),
    );
    expect(picks[0]).not.toBe(picks[1]);
  });

  test("an IP or localhost upstream is used as given", async () => {
    const pool = createUpstreamPool("http://127.0.0.1:9", async () => {
      throw new Error("must not resolve");
    });
    expect(await pool.next()).toBe("http://127.0.0.1:9");
  });

  test("a GET that cannot connect retries on the next address", async () => {
    // The upstream listens on 127.0.0.1 only, so [::1] refuses at once. The
    // pool's first pick is the second address.
    const flaky = createForwarder({
      upstream: `http://api.internal:${upstream.port}`,
      log: quietLog,
      resolve: async () => ["127.0.0.1", "::1"],
    });
    const server = Bun.serve<WsConnData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => flaky.handle(req, srv) as Promise<Response>,
      websocket: flaky.websocket,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ok`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("from api");
    } finally {
      server.stop(true);
    }
  });
});

describe("sockets", () => {
  test("relays frames both ways and keeps the rivet subprotocol", async () => {
    const socket = new WebSocket(
      `${origin.replace("http", "ws")}/rivet/gateway/x/connect`,
      ["rivet", "rivet_encoding.json"],
    );
    const frames: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onerror = () => reject(new Error("socket error"));
      socket.onmessage = (event) => {
        frames.push(String(event.data));
        if (frames.length === 1) socket.send("ping");
        if (frames.length === 2) resolve();
      };
    });
    expect(socket.protocol).toBe("rivet");
    expect(frames[0]).toBe("hello rivet, rivet_encoding.json");
    expect(frames[1]).toBe("echo:ping");
    socket.close(1000);
  });
});
