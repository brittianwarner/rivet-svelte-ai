import type { Adapter } from "@sveltejs/kit";
import type { Build } from "bun";
import "./ambient.js";

/** Options for the experimental Bun standalone executable output. */
export interface CompileOptions {
  /** Bun standalone executable target, e.g. `bun-linux-x64-modern`. Defaults to the host. */
  target?: Build.CompileTarget;
  /** Output executable path. Defaults to `<out>/app`. */
  outfile?: string;
  /** Enable Bun bytecode in the compiled executable. Defaults to true. */
  bytecode?: boolean;
  /** Minify the compiled executable input. Defaults to true. */
  minify?: boolean;
  /** Bun sourcemap mode. Defaults to `linked`. */
  sourcemap?: "none" | "linked" | "external" | "inline";
  /**
   * Files or directories to embed in the executable. Defaults to
   * `<out>/client` and `<out>/prerendered` (those that exist), so the binary
   * is self-contained. Passing a value replaces the default.
   */
  assets?: string[];
  /** Runtime arguments baked into the executable (Bun `execArgv`). */
  execArgv?: string[];
  /** Load `.env` files from the working directory at startup. Defaults to false (Bun's default is true). */
  autoloadDotenv?: boolean;
  /** Load `bunfig.toml` from the working directory at startup. Defaults to false (Bun's default is true). */
  autoloadBunfig?: boolean;
}

/** Build and Bun runtime defaults for the SvelteKit 3 adapter. */
export interface AdapterOptions {
  /** Output directory. Defaults to `build`. */
  out?: string;
  /** Precompress client and prerendered assets with gzip and brotli. Defaults to true. */
  precompress?: boolean;
  /** Optional prefix for runtime env vars, matching adapter-node's convention. */
  envPrefix?: string;
  /** Serve client and prerendered assets before SSR. Defaults to true. */
  serveAssets?: boolean;
  /** Default runtime BODY_SIZE_LIMIT. Defaults to 1200000000. */
  bodySizeLimit?: string | number;
  /** Default Bun idle timeout in seconds, an integer from 0 to 255. Defaults to 255. */
  idleTimeout?: number;
  /** Path prefixes that get `server.timeout(request, 0)` automatically. */
  noIdleTimeoutPaths?: string[];
  /** Experimental Bun standalone executable build. Disabled by default. */
  compile?: boolean | CompileOptions;
}

export default function adapter(options?: AdapterOptions): Adapter;
