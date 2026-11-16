/**
 * Boots files/handler.js against a synthetic adapter output directory, so the
 * static/prerendered request pipeline is testable without a SvelteKit build.
 *
 * The layout mirrors what the adapter writes: `handler.js` + helpers copied
 * with build-time tokens replaced, a Kit 3 server instance stub and
 * build-owned asset handoff, and `client/` / `prerendered/` trees. The stub
 * answers SSR with a small echo/SSE surface.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const filesDir = join(import.meta.dir, "..", "files");

export interface HarnessOptions {
  /** client/ tree, path relative to client/<base> → contents. */
  client?: Record<string, string | Uint8Array>;
  /** prerendered/ tree, path relative to prerendered/<base> → contents. */
  prerenderedFiles?: Record<string, string | Uint8Array>;
  /** Kit's `prerendered` set (decoded public paths, base included). */
  prerenderedPaths?: string[];
  precompress?: boolean;
  base?: string;
  /** Files present at startup that were not produced by the application build. */
  unlistedClient?: Record<string, string>;
  /** Paths (relative to the output root) whose mtime is forced to 0. */
  zeroMtime?: string[];
}

export interface Harness {
  origin: string;
  root: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Raw HTTP/1.1 request; returns the head (status line + headers). */
  raw(request: string): Promise<string>;
  stop(): Promise<void>;
}

const STUB_SERVER = `
export const server = new class {
  async init() {}
  async respond(request, options) {
    const url = new URL(request.url);
    if (url.pathname === "/address") {
      return Response.json({ address: options.getClientAddress() });
    }
    if (url.pathname === "/sse") {
      return new Response("data: hi\\n\\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/sse-explicit") {
      return new Response("data: hi\\n\\n", { headers: { "content-type": "text/event-stream", "x-accel-buffering": "yes" } });
    }
    if (url.pathname === "/slow") {
      globalThis.__slowAborted = false;
      request.signal.addEventListener("abort", () => { globalThis.__slowAborted = true; });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return new Response("slow");
    }
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    return new Response(JSON.stringify({
      ssr: true,
      method: request.method,
      url: request.url,
      header: request.headers.get("x-probe"),
      body,
    }), { status: url.pathname === "/echo" ? 200 : 404, headers: { "content-type": "application/json" } });
  }
};
`;

function write(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export async function startHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const base = options.base ?? "";
  const root = mkdtempSync(join(tmpdir(), "adapter-bun-handler-"));

  const replace: Record<string, string> = {
    ENV: "./env.js",
    "#@example/sveltekit-adapter-bun": "./adapter-bun.js",
    ENV_PREFIX: JSON.stringify(""),
    PRECOMPRESS: JSON.stringify(options.precompress ?? true),
    SERVE_ASSETS: JSON.stringify(true),
  };
  const pattern = new RegExp(`\\b(${Object.keys(replace).join("|")})\\b`, "g");
  for (const name of readdirSync(filesDir)) {
    if (!name.endsWith(".js") || name === "index.js") continue;
    const source = readFileSync(join(filesDir, name), "utf8");
    write(
      join(root, name),
      source
        .replaceAll("#@example/sveltekit-adapter-bun", "./adapter-bun.js")
        .replace(pattern, (_match, key: string) => replace[key] ?? key),
    );
  }

  write(join(root, "server", "server.js"), STUB_SERVER);
  write(
    join(root, "adapter-bun.js"),
    `
export { server } from './server/server.js';
export const dir = import.meta.dir;
export const appPath = '_app';
export const origin = undefined;
export const clientAssets = ${JSON.stringify(Object.keys(options.client ?? {}).map((path) => `${base.slice(1)}${base ? "/" : ""}${path}`))};
export const prerenderedAssets = ${JSON.stringify(Object.keys(options.prerenderedFiles ?? {}).map((path) => `${base.slice(1)}${base ? "/" : ""}${path}`))};
export const prerendered = new Set(${JSON.stringify(options.prerenderedPaths ?? [])});
export const base = ${JSON.stringify(base)};
`,
  );

  for (const [rel, contents] of Object.entries(options.client ?? {})) {
    write(join(root, "client", base, rel), contents);
  }
  for (const [rel, contents] of Object.entries(
    options.prerenderedFiles ?? {},
  )) {
    write(join(root, "prerendered", base, rel), contents);
  }
  for (const [rel, contents] of Object.entries(options.unlistedClient ?? {})) {
    write(join(root, "client", base, rel), contents);
  }
  for (const rel of options.zeroMtime ?? []) {
    utimesSync(join(root, rel), 0, 0);
  }

  const { getHandler } = (await import(join(root, "handler.js"))) as {
    getHandler: (options?: object) => {
      fetch: (request: Request, server: unknown) => Promise<Response>;
      routes: Record<string, unknown>;
    };
  };
  const { fetch: handleFetch, routes } = getHandler();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    routes: routes as never,
    fetch: handleFetch as never,
    error(error) {
      console.error(error);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    root,
    // decompress: false so encoded variants (and ranges of them) arrive as
    // sent; Bun's fetch otherwise adds Accept-Encoding and inflates.
    fetch: (path, init) =>
      fetch(`${origin}${path}`, { decompress: false, ...init }),
    raw: (request) =>
      new Promise((resolve) => {
        let buffer = "";
        const done = () => resolve(buffer.split("\r\n\r\n")[0] ?? "");
        void Bun.connect({
          hostname: "127.0.0.1",
          port: server.port as number,
          socket: {
            open(socket) {
              socket.write(request);
            },
            data(_socket, data) {
              buffer += new TextDecoder().decode(data);
              if (buffer.includes("\r\n\r\n")) done();
            },
            close: done,
            error: done,
          },
        });
      }),
    async stop() {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
