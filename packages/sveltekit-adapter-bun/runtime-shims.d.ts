// Build-time tokens that the adapter Vite plugin transforms in files/*.js. Declared here,
// not in the published index.d.ts, so they never leak into consumer projects
// as globals that type-check but are undefined at runtime.
declare const ENV_PREFIX: string;
declare const PRECOMPRESS: boolean;
declare const SERVE_ASSETS: boolean;
declare const DEFAULT_BODY_SIZE_LIMIT: string;
declare const DEFAULT_IDLE_TIMEOUT: string;
declare const DEFAULT_NO_IDLE_TIMEOUT_PATHS: string;

declare module "#@example/sveltekit-adapter-bun" {
  export const dir: string;
  export const appPath: string;
  export const origin: string | undefined;
  export const clientAssets: string[];
  export const prerenderedAssets: string[];
  export const prerendered: Set<string>;
  export const base: string;
  export const server: {
    init(options: {
      env: Record<string, string | undefined>;
      read(file: string): ReadableStream;
    }): Promise<void>;
    respond(
      request: Request,
      options: { platform: unknown; getClientAddress(): string },
    ): Promise<Response>;
  };
}
