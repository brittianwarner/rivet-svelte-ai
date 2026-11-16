/**
 * The composition root. Each service lives in its own package; ROLE picks
 * which of them this process runs (see `servicesFor` in @example/config):
 *
 *   engine  @example/rivet-engine  engine node from S3_*, namespace bootstrap
 *   actors  @example/actors        runner: registers with the engine, runs actors
 *   front   @example/api           /api/*   (Elysia)
 *           @example/rivet-edge    /rivet/* (gateway relay, admin denied)
 *           @example/web           everything else (SvelteKit, Bun adapter)
 *
 * Boot: engine → namespace + pool → HTTP listener (liveness only) → runner
 * registers → readiness flips to 200.
 *
 * Stop (SIGTERM): readiness 503 → HTTP stops accepting → actors sleep and the
 * runner deregisters → the engine hands off its partitions and exits. Each step
 * waits for the one before it; the platform's draining window covers the total.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { createClient } from "rivetkit/client";
import {
  chooseProvider,
  configureEntityAuth,
  createRegistry,
  serverActorParams,
  type AppRegistry,
} from "@example/actors";
import { createApi, entityRoutes } from "@example/api";
import {
  actorToken,
  allowedOrigins,
  enginePort,
  loadRootEnv,
  log,
  portFromEnv,
  rivetTarget,
  role,
  servicesFor,
  type RivetTarget,
} from "@example/config";
import {
  deriveTrustedClientIp,
  createEngineTokenMinter,
  createRivetGatewayProxy,
  type WsConnData,
} from "@example/rivet-edge";
import {
  bootstrapNamespace,
  startEngineNode,
  type EngineHandle,
} from "@example/rivet-engine";

interface WebHandler {
  fetch: (
    request: Request,
    server: Server<undefined>,
  ) => Response | Promise<Response>;
  routes: Record<string, unknown>;
}

/** The web build is optional: in development Vite serves the pages. */
async function loadWeb(): Promise<WebHandler | null> {
  // `none` serves /api and /rivet only (tests, or a separate web tier).
  if (process.env.WEB_HANDLER === "none") return null;
  const path =
    process.env.WEB_HANDLER ||
    fileURLToPath(new URL("../../web/build/handler.js", import.meta.url));
  if (!existsSync(path)) return null;
  const mod = (await import(path)) as {
    getHandler: (o: { noIdleTimeoutPaths: string[] }) => WebHandler;
  };
  return mod.getHandler({ noIdleTimeoutPaths: ["/rivet"] });
}

async function releaseVersion(): Promise<number> {
  const fromEnv = Number(process.env.RIVET_NODE_VERSION);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const file = Bun.file(
    fileURLToPath(new URL("../../../.release-version", import.meta.url)),
  );
  if (await file.exists()) return Number((await file.text()).trim()) || 1;
  return 1;
}

function onSignals(stop: (signal: string) => Promise<void>): void {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) {
        log.warn("second signal: exiting now", { signal });
        process.exit(1);
      }
      stopping = true;
      void stop(signal).then(
        () => process.exit(0),
        (error) => {
          log.error("shutdown failed", { error: String(error) });
          process.exit(1);
        },
      );
    });
  }
}

function listenAddress(): { port: number; hostname: string } {
  return {
    port: portFromEnv(process.env.PORT ?? process.env.API_PORT, 3001),
    hostname:
      process.env.HOST ||
      process.env.API_HOST ||
      (process.env.NODE_ENV === "production" ? "::" : "127.0.0.1"),
  };
}

/** ROLE=engine: only the node. Guard serves /health on 6420 for the platform. */
async function runEngineOnly(target: RivetTarget): Promise<void> {
  if (!target.adminToken)
    throw new Error("Set RIVET_TOKEN (the engine admin token).");
  const engine = await startEngineNode({
    adminToken: target.adminToken,
    guardHost: "::",
  });
  let stopping = false;
  onSignals(async () => {
    stopping = true;
    await engine.stop();
  });
  const code = await engine.exited;
  if (stopping) process.exit(code ?? 0);
  log.error("rivet engine exited", { code });
  process.exit(code || 1);
}

/** Front-only replicas have no runner: ready means the engine answers. */
function engineReachable(endpoint: string): () => Promise<boolean> {
  let checkedAt = 0;
  let last = false;
  return async () => {
    if (Date.now() - checkedAt < 2000) return last;
    checkedAt = Date.now();
    try {
      const response = await fetch(`${endpoint}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      last = response.ok;
    } catch {
      last = false;
    }
    return last;
  };
}

export async function main(): Promise<void> {
  loadRootEnv();
  const mode = role();
  const run = servicesFor(mode);
  const target = rivetTarget();

  if (run.engine && !run.actors && !run.front) return runEngineOnly(target);
  if (run.engine && !target.spawnLocal) {
    throw new Error(
      `ROLE=${mode} runs its own engine; unset RIVET_ENDPOINT (or use ROLE=app).`,
    );
  }
  if (!run.engine && target.spawnLocal) {
    throw new Error(
      `ROLE=${mode} needs RIVET_ENDPOINT: the engine runs in another service.`,
    );
  }

  let engine: EngineHandle | null = null;
  if (run.engine && process.env.S3_BUCKET) {
    if (!target.adminToken)
      throw new Error("Set RIVET_TOKEN (the engine admin token).");
    engine = await startEngineNode({
      adminToken: target.adminToken,
      guardHost: "127.0.0.1",
    });
    target.endpoint = engine.endpoint;
    target.spawnLocal = false;
  }
  // ROLE=all without S3_BUCKET: RivetKit spawns a single development engine.

  if (!target.spawnLocal && target.adminToken) {
    const ready = await bootstrapNamespace({
      endpoint: target.endpoint,
      adminToken: target.adminToken,
      namespace: target.namespace,
      pool: target.pool,
    });
    if (!ready.success)
      throw new Error(`Rivet namespace bootstrap failed: ${ready.error}`);
  }

  // Actors verify principals; the front signs them. Both need the secret.
  configureEntityAuth();

  const version = await releaseVersion();
  const registry = run.actors
    ? createRegistry({
        ...(target.spawnLocal
          ? {}
          : {
              endpoint: target.endpoint,
              token: target.adminToken ?? undefined,
            }),
        namespace: target.namespace,
        pool: target.pool,
        version,
        localEnginePort: enginePort(),
        // Chat spends model budget: host it only when a provider is set.
        chat: chooseProvider().provider !== "none",
      })
    : null;

  let runnerReady = false;
  const ready = run.actors
    ? () => runnerReady
    : engineReachable(target.endpoint);

  const front = run.front ? await createFront(target, ready) : null;
  const server = front
    ? Bun.serve<WsConnData>({
        ...listenAddress(),
        development: false,
        idleTimeout: 255,
        routes: front.routes,
        fetch: front.fetch,
        websocket: front.websocket,
        error(error) {
          log.error("unhandled request error", { error: error.message });
          return new Response("Internal Server Error", { status: 500 });
        },
      })
    : // ROLE=runner: no public surface, just the platform's health checks.
      Bun.serve({
        ...listenAddress(),
        development: false,
        routes: {
          "/api/health": () => Response.json({ ok: true }),
          "/api/health/actors": () =>
            Response.json(
              { ok: runnerReady },
              { status: runnerReady ? 200 : 503 },
            ),
        },
        fetch: () => new Response("Not found", { status: 404 }),
      });
  log.info("listening", {
    url: server.url.href,
    role: mode,
    services: Object.entries(run)
      .filter(([, on]) => on)
      .map(([name]) => name),
    web: front?.hasWeb ?? false,
    version,
    engine: target.endpoint,
  });

  let shuttingDown = false;
  onSignals(async (signal) => {
    shuttingDown = true;
    log.info("stopping", { signal, pendingRequests: server.pendingRequests });
    runnerReady = false;
    await server.stop();
    await front?.dispose();
    await registry?.shutdown();
    await engine?.stop();
  });

  // A dead engine leaves the runner with nowhere to go: restart the container.
  void engine?.exited.then((code) => {
    if (shuttingDown) return;
    log.error("rivet engine exited unexpectedly", { code });
    process.exit(1);
  });

  if (registry) {
    await registry.startAndWait();
    runnerReady = true;
    const choice = chooseProvider();
    log.info("actors ready", {
      provider: choice.provider,
      model: choice.modelId,
    });
  }
}

interface Front {
  routes: Record<string, unknown>;
  fetch: (
    request: Request,
    server: Server<WsConnData>,
  ) => Response | Promise<Response>;
  websocket: ReturnType<typeof createRivetGatewayProxy>["websocket"];
  hasWeb: boolean;
  dispose(): Promise<void>;
}

/** The public port: web, /api and the /rivet edge. Stateless; scale freely. */
async function createFront(
  target: RivetTarget,
  ready: () => boolean | Promise<boolean>,
): Promise<Front> {
  const origins = allowedOrigins();
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim() || undefined;

  // Server-side calls go straight to the engine with the admin token.
  const client = createClient<AppRegistry>({
    endpoint: target.endpoint,
    namespace: target.namespace,
    ...(target.adminToken ? { token: target.adminToken } : {}),
  });

  // Bun knows the socket's address; Elysia sees only the Request.
  const clients = new WeakMap<Request, string>();
  const api = new Elysia()
    .use(
      createApi({
        origins,
        publicOrigin,
        namespace: target.namespace,
        token: actorToken,
        provider: chooseProvider,
        ready,
        increment: (name, by) =>
          client.counter
            .getOrCreate(["counter", name], { params: serverActorParams() })
            .increment(by),
      }),
    )
    .use(
      entityRoutes({
        origins,
        publicOrigin,
        clientAddress: (request) => clients.get(request),
      }),
    );

  const gateway = createRivetGatewayProxy({
    upstreamHttp: target.endpoint,
    allowedOrigins: origins,
    prefix: "/rivet",
    ...(target.adminToken
      ? {
          engineCredential: createEngineTokenMinter({
            upstreamHttp: target.endpoint,
            adminToken: target.adminToken,
            namespace: target.namespace,
          }),
        }
      : {}),
  });

  const web = await loadWeb();
  return {
    routes: {
      ...(web?.routes as object | undefined),
      "/rivet/*": (request: Request, srv: Server<WsConnData>) => {
        srv.timeout(request, 0);
        return gateway.handleRequest(request, srv);
      },
      "/api/*": (request: Request, srv: Server<WsConnData>) => {
        const address = deriveTrustedClientIp(
          request.headers.get("x-forwarded-for"),
          srv.requestIP(request)?.address ?? null,
        );
        if (address) clients.set(request, address);
        return api.handle(request);
      },
    },
    fetch: (request, srv) =>
      web
        ? web.fetch(request, srv as unknown as Server<undefined>)
        : new Response("Not found", { status: 404 }),
    websocket: gateway.websocket,
    hasWeb: web !== null,
    dispose: () => client.dispose(),
  };
}
