import { COUNTER_NAME_PATTERN, type ClientConfig } from "@example/wire";
import { Elysia } from "elysia";
import { log } from "@example/config";

/** Which model the chat actor will use. Supplied by whoever owns the actors. */
export interface ProviderChoice {
  provider: "openrouter" | "gemini" | "none";
  modelId: string | null;
}

export interface ApiDependencies {
  origins: string[];
  /** Origin the browser uses; the Rivet endpoint is `<origin>/rivet`. */
  publicOrigin?: string;
  namespace?: string;
  token: () => string | null;
  provider: () => ProviderChoice;
  /**
   * Readiness for the deploy healthcheck. With a local runner: it has
   * registered. Front-only replicas: the engine answers.
   */
  ready: () => boolean | Promise<boolean>;
  increment: (name: string, by: number) => Promise<number>;
}

const MAX_BODY_BYTES = 1024;

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

/** Reads at most `max` bytes, then parses JSON. Works for chunked bodies too. */
export async function readJson(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<BodyResult> {
  if (Number(request.headers.get("content-length")) > max) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400, error: "invalid_json" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { ok: false, status: 413, error: "body_too_large" };
    }
    chunks.push(value);
  }
  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

/** Browser origin for the rivet endpoint: configured, else what the edge saw. */
function originOf(request: Request, configured?: string): string {
  if (configured) return configured;
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host");
  return `${proto || url.protocol.replace(":", "")}://${host || url.host}`;
}

/**
 * The HTTP API. Pure: no engine, no environment reads, so tests call
 * `app.handle(new Request(...))` directly.
 */
export function createApi(deps: ApiDependencies) {
  const sameSite = (request: Request) => {
    const origin = request.headers.get("origin");
    return (
      !origin || deps.origins.includes(origin) || origin === deps.publicOrigin
    );
  };

  return (
    new Elysia({ prefix: "/api" })
      .onAfterHandle(({ set }) => {
        set.headers["cache-control"] ??= "no-store";
      })
      // Liveness: the process answers. Railway restarts on failure.
      .get("/health", () => ({ ok: true }))
      // Readiness: actors can be served. Used as the deploy healthcheck so a
      // replica only takes traffic once its runner is registered.
      .get("/health/actors", async ({ set }) => {
        const ok = await deps.ready();
        set.status = ok ? 200 : 503;
        return { ok };
      })
      .get("/ready", () => {
        const choice = deps.provider();
        return { provider: choice.provider, model: choice.modelId };
      })
      .get("/client-config", ({ request }): ClientConfig => ({
        rivetEndpoint: `${originOf(request, deps.publicOrigin)}/rivet`,
        ...(deps.namespace ? { rivetNamespace: deps.namespace } : {}),
        actorToken: deps.token(),
      }))
      .post(
        "/counters/:name/increment",
        async ({ request, params, set }) => {
          if (!sameSite(request)) {
            set.status = 403;
            return { error: "origin_not_allowed" };
          }
          const name = params.name;
          if (!COUNTER_NAME_PATTERN.test(name)) {
            set.status = 400;
            return { error: "invalid_name" };
          }
          const body = await readJson(request);
          if (!body.ok) {
            set.status = body.status;
            return { error: body.error };
          }
          const value = body.value;
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            set.status = 400;
            return { error: "invalid_body" };
          }
          let by = 1;
          if ("by" in value) {
            const requested = (value as { by?: unknown }).by;
            if (
              typeof requested !== "number" ||
              !Number.isInteger(requested) ||
              requested < 1 ||
              requested > 100
            ) {
              set.status = 400;
              return { error: "invalid_by" };
            }
            by = requested;
          }
          try {
            return { count: await deps.increment(name, by) };
          } catch (error) {
            log.warn("counter action failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            set.status = 502;
            return { error: "Actor unavailable. Please retry." };
          }
        },
        // Read the raw stream ourselves so the byte cap holds before parsing.
        { parse: "none" },
      )
  );
}

export type Api = ReturnType<typeof createApi>;
