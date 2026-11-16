import type { Server } from "bun";

export interface BunAdapterPlatform {
  /**
   * Bun's active server instance for the generated SvelteKit runtime.
   * Undefined in `vite dev`, `vite preview` and prerender (`adapter.emulate()`).
   */
  server?: Server<undefined>;
  /**
   * The original Web-standard request received by `Bun.serve`.
   * Undefined in `vite dev`, `vite preview` and prerender (`adapter.emulate()`).
   */
  request?: Request;
  /**
   * Set Bun's per-request timeout in seconds. Use `0` for long-lived streams.
   * Always present; a no-op outside the production runtime.
   */
  setRequestTimeout(seconds: number): void;
}

declare global {
  namespace App {
    interface Platform {
      /** Bun-native platform controls exposed by `@example/sveltekit-adapter-bun`. */
      bun: BunAdapterPlatform;
      /** @deprecated use `platform.bun.server`. Compatibility alias, production runtime only. */
      server?: Server<undefined>;
      /** @deprecated use `platform.bun.request`. Compatibility alias, production runtime only. */
      request?: Request;
    }
  }
}
