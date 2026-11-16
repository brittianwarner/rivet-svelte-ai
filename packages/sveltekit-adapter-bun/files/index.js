import process from "node:process";
import { env, nonNegativeIntegerEnv, parseBytes } from "./env.js";
import { getHandler } from "./handler.js";

/* global DEFAULT_BODY_SIZE_LIMIT */
/* global DEFAULT_IDLE_TIMEOUT */
/* global DEFAULT_NO_IDLE_TIMEOUT_PATHS */

const path = env("SOCKET_PATH", false);
// Default to IPv6 (`::`) so the server is reachable on Railway/Fly/etc., whose
// internal + edge networking is IPv6. `::` is dual-stack (also accepts IPv4),
// so local dev still works. Override with HOST for special cases.
const host = env("HOST", "::");
const port = env("PORT", !path && "3000");
const shutdownTimeout = nonNegativeIntegerEnv("SHUTDOWN_TIMEOUT", 30);
// Bun.serve rejects idleTimeout above 255 with an error that does not name
// the variable; validate here so the (possibly prefixed) name is reported.
const idleTimeout = nonNegativeIntegerEnv(
  "IDLE_TIMEOUT",
  Number.parseInt(DEFAULT_IDLE_TIMEOUT, 10),
  { max: 255 },
);
const bodySizeLimit = parseBytes(
  env("BODY_SIZE_LIMIT", DEFAULT_BODY_SIZE_LIMIT),
  "BODY_SIZE_LIMIT",
);
const noIdleTimeoutPaths = parsePathList(
  env("NO_IDLE_TIMEOUT_PATHS", DEFAULT_NO_IDLE_TIMEOUT_PATHS),
);

if (!path && (!Number.isInteger(Number(port)) || Number(port) < 0)) {
  throw new Error(
    `Invalid PORT: ${JSON.stringify(port)}. PORT must be a non-negative integer.`,
  );
}

const { fetch: handleFetch, routes } = getHandler({ noIdleTimeoutPaths });

const serveOptions = {
  ...(path
    ? { unix: String(path) }
    : { hostname: String(host), port: Number(port) }),
  idleTimeout,
  maxRequestBodySize: bodySizeLimit,
  routes,
  fetch: handleFetch,
  // Bun enables development mode whenever NODE_ENV !== "production", and its
  // development error page leaks messages, stacks and absolute paths. Kit's
  // respond() already handles app errors; this only covers adapter faults.
  development: false,
  /** @param {Error} error */
  error(error) {
    console.error(error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  },
};

const server = Bun.serve(/** @type {any} */ (serveOptions));

const address = path
  ? `unix:${path}`
  : (server.url?.toString() ?? `http://${host}:${port}`);
console.log(
  `Listening on ${address} (Bun, idleTimeout=${idleTimeout}s, bodySizeLimit=${bodySizeLimit} bytes)`,
);

let shuttingDown = false;
let shutdownEmitted = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let forceStopTimer;

/** @param {'SIGINT' | 'SIGTERM'} reason */
function emitShutdown(reason) {
  if (shutdownEmitted) return;
  shutdownEmitted = true;
  /** @type {(...args: unknown[]) => boolean} */ (process.emit.bind(process))(
    "sveltekit:shutdown",
    reason,
  );
}

function stopListening() {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

/**
 * First signal: graceful stop. Bun's stop() closes idle keep-alive sockets at
 * once and busy ones after their response; after SHUTDOWN_TIMEOUT the force
 * timer calls stop(true) but does not exit (adapter-node parity), so app
 * handles such as DB pools must be closed from a `sveltekit:shutdown` listener.
 * Second signal: force-close every connection, run the shutdown listeners and
 * exit(1).
 *
 * @param {'SIGINT' | 'SIGTERM'} reason
 */
async function onSignal(reason) {
  if (shuttingDown) {
    await forceShutdown(reason);
    return;
  }
  await gracefulShutdown(reason);
}

/** @param {'SIGINT' | 'SIGTERM'} reason */
async function gracefulShutdown(reason) {
  shuttingDown = true;

  console.info(
    `Stopping server after ${reason} (${server.pendingRequests} pending requests)...`,
  );
  forceStopTimer = setTimeout(() => {
    console.warn(
      `Force-stopping server after ${shutdownTimeout}s shutdown timeout (${server.pendingRequests} pending requests)`,
    );
    void server.stop(true);
  }, shutdownTimeout * 1000);

  try {
    await server.stop();
  } finally {
    if (forceStopTimer) clearTimeout(forceStopTimer);
    emitShutdown(reason);
    stopListening();
    console.info("Stopped server");
  }
}

/** @param {'SIGINT' | 'SIGTERM'} reason */
async function forceShutdown(reason) {
  stopListening();
  if (forceStopTimer) clearTimeout(forceStopTimer);
  console.warn(
    `Received second ${reason}; force-stopping server (${server.pendingRequests} pending requests) and exiting`,
  );
  try {
    await server.stop(true);
  } finally {
    try {
      emitShutdown(reason);
    } finally {
      process.exit(1);
    }
  }
}

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

/** @param {unknown} raw */
function parsePathList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => (path.startsWith("/") ? path : `/${path}`));
}

export { host, path, port, server };
