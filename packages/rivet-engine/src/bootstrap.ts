/**
 * Make sure the namespace and node pool exist before the actor runner dials.
 *
 * A fresh engine has neither. Every replica runs this at boot; it is
 * idempotent, so racing replicas converge (a lost creation race retries and
 * then finds the winner's namespace). An existing pool's configuration is
 * never overwritten.
 */
import { log } from "@example/config";

export interface BootstrapOptions {
  endpoint: string;
  adminToken: string;
  namespace: string;
  pool: string;
  /** Storage may still be electing partitions when /health first answers. */
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type BootstrapResult =
  { success: true } | { success: false; error: string };

export async function bootstrapNamespace(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 90;
  const delayMs = opts.delayMs ?? 2_000;
  const headers = {
    authorization: `Bearer ${opts.adminToken}`,
    "content-type": "application/json",
  };
  const call = (path: string, init: RequestInit = {}) =>
    doFetch(new URL(path, opts.endpoint), {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });

  let lastError = "not attempted";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return { success: false, error: "aborted" };
    try {
      const list = await call(
        `/namespaces?name=${encodeURIComponent(opts.namespace)}&limit=1`,
      );
      if (!list.ok) throw new Error(`namespace lookup HTTP ${list.status}`);
      const found = (await list.json()) as {
        namespaces?: Array<{ name?: string }>;
      };
      if (!found.namespaces?.some((item) => item.name === opts.namespace)) {
        const created = await call("/namespaces", {
          method: "POST",
          body: JSON.stringify({ name: opts.namespace }),
        });
        // Another replica may have won; the next attempt finds it.
        if (!created.ok)
          throw new Error(`namespace create HTTP ${created.status}`);
      }

      const poolPath = `/pools/${encodeURIComponent(opts.pool)}?namespace=${encodeURIComponent(opts.namespace)}`;
      let pool = await call(poolPath);
      if (pool.status === 404)
        pool = await call(poolPath, { method: "PUT", body: "{}" });
      if (!pool.ok) throw new Error(`pool HTTP ${pool.status}`);

      log.info("rivet namespace ready", {
        namespace: opts.namespace,
        pool: opts.pool,
        attempt,
      });
      return { success: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt % 10 === 0)
        log.warn("rivet namespace not ready yet", {
          attempt,
          error: lastError,
        });
      await Bun.sleep(delayMs);
    }
  }
  return { success: false, error: lastError };
}
