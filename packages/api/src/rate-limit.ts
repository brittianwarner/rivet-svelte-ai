/**
 * A fixed-window counter per key, in memory. Each replica limits on its own,
 * which is enough to stop a loop hammering one endpoint. Shared limits across
 * replicas belong in an actor or at the edge.
 */
export interface RateLimiter {
  /** Count one hit. Returns the seconds to wait when the key is over its limit. */
  hit(key: string): { ok: true } | { ok: false; retryAfter: number };
}

/** Keys kept before expired windows are swept. */
const MAX_KEYS = 10_000;

export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  const sweep = (at: number) => {
    for (const [key, window] of windows)
      if (window.resetAt <= at) windows.delete(key);
  };

  return {
    hit(key) {
      const at = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= at) {
        if (windows.size >= MAX_KEYS) sweep(at);
        window = { count: 0, resetAt: at + opts.windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= opts.limit) return { ok: true };
      return { ok: false, retryAfter: Math.ceil((window.resetAt - at) / 1000) };
    },
  };
}
