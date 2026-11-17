/**
 * The composition root. Each service lives in its own package; ROLE picks
 * which of them this process runs (see `servicesFor` in @example/config):
 *
 *   engine  @example/rivet-engine  an S3-backed cluster node, or a local node
 *   actors  @example/actors        runner: registers with the engine, runs actors
 *   api     @example/api           /api/*   (Elysia)
 *           @example/rivet-edge    /rivet/* (gateway relay, admin denied)
 *   web     @example/web           pages (SvelteKit, Bun adapter); with no api
 *                                  in this process, /api and /rivet are
 *                                  forwarded to API_URL
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
  apiUrl,
  engineDataDir,
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
  createEngineTokenMinter,
  createForwarder,
  createRivetGatewayProxy,
  deriveTrustedClientIp,
  type WsConnData,
} from "@example/rivet-edge";
import {
  bootstrapNamespace,
  startEngineNode,
  startLocalEngine,
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
  // `none` skips the pages (tests).
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
  if (!process.env.S3_BUCKET?.trim())
    throw new Error(
      "ROLE=engine is a cluster node: set S3_BUCKET and the other S3_* values.",
    );
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

const production = process.env.NODE_ENV === "production";
/** How long a stopping replica lets in-flight requests finish. */
const HTTP_DRAIN_MS = production ? 10_000 : 500;

/**
 * Stop accepting, let in-flight requests finish, then close what is left.
 * `server.stop()` alone never resolves while a socket is open, so without the
 * second step a replica with live browsers would never reach its actor drain.
 * Closed sockets reconnect through another replica.
 */
async function stopListening(server: Server<WsConnData>): Promise<void> {
  await Promise.race([server.stop(), Bun.sleep(HTTP_DRAIN_MS)]);
  await server.stop(true);
}

/**
 * ROLE=web: pages, plus /api and /rivet forwarded to the api service over the
 * private network. No engine, no actors, no secrets. Scale it on page load.
 */
async function runWeb(): Promise<void> {
  const upstream = apiUrl();
  const web = await loadWeb();
  if (!web && process.env.WEB_HANDLER !== "none")
    throw new Error("ROLE=web needs the web build: run `bun run build`.");
  const forwarder = createForwarder({ upstream });
  let accepting = true;
  const server = Bun.serve<WsConnData>({
    ...listenAddress(),
    development: false,
    idleTimeout: 255,
    routes: {
      ...(web?.routes as object | undefined),
      // This replica's own liveness: never depends on the api.
      "/healthz": () =>
        Response.json({ ok: accepting }, { status: accepting ? 200 : 503 }),
      "/rivet/*": (request: Request, srv: Server<WsConnData>) => {
        srv.timeout(request, 0);
        return forwarder.handle(request, srv);
      },
      "/api/*": (request: Request, srv: Server<WsConnData>) =>
        forwarder.handle(request, srv),
    },
    fetch: (request, srv) =>
      web
        ? web.fetch(request, srv as unknown as Server<undefined>)
        : new Response("Not found", { status: 404 }),
    websocket: forwarder.websocket,
    error(error) {
      log.error("unhandled request error", { error: error.message });
      return new Response("Internal Server Error", { status: 500 });
    },
  });
  log.info("listening", {
    url: server.url.href,
    role: "web",
    web: web !== null,
    api: upstream,
  });
  onSignals(async (signal) => {
    accepting = false;
    log.info("stopping", { signal, pendingRequests: server.pendingRequests });
    await stopListening(server);
  });
}

async function startEngine(target: RivetTarget): Promise<EngineHandle> {
  if (!target.adminToken)
    throw new Error("Set RIVET_TOKEN (the engine admin token).");
  if (process.env.S3_BUCKET?.trim()) {
    return startEngineNode({
      adminToken: target.adminToken,
      guardHost: "127.0.0.1",
    });
  }
  // No bucket: one node with its data on this machine.
  if (process.env.NODE_ENV === "production")
    log.warn(
      "no S3_BUCKET: running a single local engine; data is lost with the container",
    );
  return startLocalEngine({
    dir: engineDataDir(),
    port: enginePort(),
    adminToken: target.adminToken,
  });
}

export async function main(): Promise<void> {
  loadRootEnv();
  const mode = role();
  const run = servicesFor(mode);
  if (!run.engine && !run.actors && !run.api) return runWeb();

  const target = rivetTarget();
  if (run.engine && !run.actors) return runEngineOnly(target);
  if (run.engine && !target.local) {
    throw new Error(
      `ROLE=${mode} runs its own engine; unset RIVET_ENDPOINT (or use ROLE=api).`,
    );
  }
  if (!run.engine && target.local) {
    throw new Error(
      `ROLE=${mode} needs RIVET_ENDPOINT: the engine runs in another service.`,
    );
  }

  const engine = run.engine ? await startEngine(target) : null;
  if (engine) target.endpoint = engine.endpoint;

  if (target.adminToken) {
    const ready = await bootstrapNamespace({
      endpoint: target.endpoint,
      adminToken: target.adminToken,
      namespace: target.namespace,
      pool: target.pool,
      // A local engine elects its partition in well under a second.
      ...(production ? {} : { delayMs: 250, attempts: 240 }),
    });
    if (!ready.success)
      throw new Error(`Rivet namespace bootstrap failed: ${ready.error}`);
  }

  // Actors verify principals and keep files; the API signs principals.
  configureEntityAuth();

  const version = await releaseVersion();
  const registry = createRegistry({
    endpoint: target.endpoint,
    token: target.adminToken ?? undefined,
    namespace: target.namespace,
    pool: target.pool,
    version,
    // Development: a reload waits seconds, not the engine's stop threshold.
    ...(production ? {} : { shutdownGraceMs: 3_000 }),
    // Chat spends model budget: host it only when a provider is set.
    chat: chooseProvider().provider !== "none",
  });

  let runnerReady = false;
  const front = await createFront(target, () => runnerReady, run.web);
  const server = Bun.serve<WsConnData>({
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
  });
  log.info("listening", {
    url: server.url.href,
    role: mode,
    services: Object.entries(run)
      .filter(([, on]) => on)
      .map(([name]) => name),
    web: front.hasWeb,
    version,
    engine: target.endpoint,
  });

  let shuttingDown = false;
  onSignals(async (signal) => {
    shuttingDown = true;
    log.info("stopping", { signal, pendingRequests: server.pendingRequests });
    runnerReady = false;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    await stopListening(server);
    await front.dispose();
    log.info("stopped listening", { ms: elapsed() });
    await registry.shutdown();
    log.info("actors drained", { ms: elapsed() });
    if (engine) {
      await engine.stop();
      log.info("engine stopped", { ms: elapsed() });
    }
  });

  // A dead engine leaves the runner with nowhere to go: restart the container.
  void engine?.exited.then((code) => {
    if (shuttingDown) return;
    log.error("rivet engine exited unexpectedly", { code });
    process.exit(1);
  });

  await registry.startAndWait();
  runnerReady = true;
  const choice = chooseProvider();
  log.info("actors ready", {
    provider: choice.provider,
    model: choice.modelId,
  });
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

/** /api and the /rivet edge, plus the pages when this process serves them. */
async function createFront(
  target: RivetTarget,
  ready: () => boolean | Promise<boolean>,
  withWeb: boolean,
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

  const web = withWeb ? await loadWeb() : null;
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
