import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const files = fileURLToPath(new URL("./files", import.meta.url)).replaceAll(
  "\\",
  "/",
);
const handoff = "#@example/sveltekit-adapter-bun";

/** Bun's `idleTimeout` ceiling in seconds; `Bun.serve` throws above it. */
const MAX_IDLE_TIMEOUT = 255;

/**
 * @typedef {{
 *   target?: import('bun').Build.CompileTarget;
 *   outfile?: string;
 *   bytecode?: boolean;
 *   minify?: boolean;
 *   sourcemap?: 'none' | 'linked' | 'external' | 'inline';
 *   assets?: string[];
 *   execArgv?: string[];
 *   autoloadDotenv?: boolean;
 *   autoloadBunfig?: boolean;
 * }} CompileOptions
 * @typedef {{ out?: string; precompress?: boolean; envPrefix?: string; serveAssets?: boolean; bodySizeLimit?: string | number; idleTimeout?: number; noIdleTimeoutPaths?: string[]; compile?: boolean | CompileOptions }} AdapterOptions
 */

/**
 * `Bun.CompileBuildOptions` plus `assets`, which the pinned @types/bun 1.3.14
 * does not declare yet (bun-types 1.4.2 does; the Bun 1.4 runtime supports it).
 * @typedef {import('bun').CompileBuildOptions & { assets?: string[] }} BunCompileBuildOptions
 */

/**
 * Bun-native SvelteKit adapter. It intentionally preserves adapter-node's
 * build contract while replacing the runtime HTTP stack with Bun primitives.
 *
 * @param {AdapterOptions} [opts]
 * @returns {import('@sveltejs/kit').Adapter}
 */
export default function adapter(opts = {}) {
  const {
    out = "build",
    precompress = true,
    envPrefix = "",
    serveAssets = true,
    bodySizeLimit = "1200000000",
    idleTimeout = MAX_IDLE_TIMEOUT,
    noIdleTimeoutPaths = ["/api/rivet", "/api/mcp"],
    compile = false,
  } = opts;

  if (
    !Number.isInteger(idleTimeout) ||
    idleTimeout < 0 ||
    idleTimeout > MAX_IDLE_TIMEOUT
  ) {
    throw new Error(
      `@example/sveltekit-adapter-bun: idleTimeout must be an integer from 0 to ${MAX_IDLE_TIMEOUT} seconds (Bun.serve limit), got ${String(idleTimeout)}.`,
    );
  }

  return {
    name: "@example/sveltekit-adapter-bun",

    async adapt(builder) {
      const base = builder.config.paths.base;
      rmSync(out, { recursive: true, force: true });
      builder.log.minor("Copying assets");
      const clientFiles = builder.writeClient(`${out}/client${base}`);
      const prerenderedFiles = builder.writePrerendered(
        `${out}/prerendered${base}`,
      );
      builder.log.minor(
        precompress ? "Compressing assets" : "Preparing assets",
      );
      const [clientCompressed, prerenderedCompressed] = precompress
        ? await Promise.all([
            builder.compress(`${out}/client${base}`),
            builder.compress(`${out}/prerendered${base}`),
          ])
        : [[], []];

      // Kit 3 owns server creation and its manifest. Adapter entries share the
      // app's Vite SSR graph, preserving Svelte export conditions and a single
      // copy of instrumentation-sensitive modules.
      const server = resolve(builder.getServerDirectory());
      builder.generateServerInstance(`${server}/server.js`);
      if (builder.hasServerInstrumentationFile()) {
        builder.instrument({
          entrypoint: `${server}/adapter-index.js`,
          instrumentation: `${server}/instrumentation.server.js`,
          initializer: builder.createInstrumentationInitializer({
            outputDirectory: server,
            environment: "export default Bun.env;",
          }),
          module: { exports: ["path", "host", "port", "server"] },
        });
      }
      builder.copy(server, `${out}/server`);
      writeFileSync(
        `${out}/adapter-bun.js`,
        [
          `export { server } from './server/server.js';`,
          `export const dir = import.meta.dir;`,
          `export const base = ${JSON.stringify(base)};`,
          `export const appPath = ${JSON.stringify(builder.config.appDir)};`,
          `export const origin = ${JSON.stringify(builder.config.paths.origin)};`,
          // Serve only build-owned files. Runtime directory scans can expose
          // files placed in the output tree after the build.
          `export const clientAssets = ${JSON.stringify(servableAssets(clientFiles, base, clientCompressed))};`,
          `export const prerenderedAssets = ${JSON.stringify(servableAssets(prerenderedFiles, base, prerenderedCompressed))};`,
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
        ].join("\n"),
      );
      writeFileSync(
        `${out}/index.js`,
        "export * from './server/adapter-index.js';\n",
      );
      writeFileSync(
        `${out}/handler.js`,
        "export * from './server/handler.js';\n",
      );
      if (compile) await compileEntrypoint({ out, compile });
    },

    vite: {
      plugins: {
        post: [
          {
            name: "vite-plugin-sveltekit-adapter-bun",
            apply: "build",
            config(config) {
              const pkg = JSON.parse(readFileSync("package.json", "utf8"));
              const noExternal = Array.isArray(config.ssr?.noExternal)
                ? config.ssr.noExternal
                : [];
              return {
                ssr: {
                  external: Object.keys(pkg.dependencies || {}).filter(
                    (dep) =>
                      !noExternal.some((rule) =>
                        typeof rule === "string"
                          ? rule === dep
                          : rule.test(dep),
                      ),
                  ),
                  noExternal: true,
                },
                environments: {
                  ssr: {
                    resolve: {
                      conditions: [
                        "bun",
                        "node",
                        "module",
                        "import",
                        "default",
                      ],
                    },
                    build: {
                      rolldownOptions: {
                        input: {
                          "adapter-index": `${files}/index.js`,
                          "adapter-env": `${files}/env.js`,
                          handler: `${files}/handler.js`,
                        },
                        external: [handoff],
                        output: {
                          paths: { [handoff]: "../adapter-bun.js" },
                          chunkFileNames: (chunk) =>
                            chunk.moduleIds.some((id) => id.startsWith(files))
                              ? "adapter-bun-[name].js"
                              : "chunks/[name].js",
                        },
                      },
                    },
                  },
                },
              };
            },
            transform(code, id) {
              if (!id.startsWith(`${files}/`)) return;
              // Replace adapter tokens only in adapter files; application code
              // can legitimately contain identifiers with these names.
              const tokens = {
                ENV_PREFIX: JSON.stringify(envPrefix),
                PRECOMPRESS: JSON.stringify(precompress),
                SERVE_ASSETS: JSON.stringify(serveAssets),
                DEFAULT_BODY_SIZE_LIMIT: JSON.stringify(String(bodySizeLimit)),
                DEFAULT_IDLE_TIMEOUT: JSON.stringify(String(idleTimeout)),
                DEFAULT_NO_IDLE_TIMEOUT_PATHS: JSON.stringify(
                  noIdleTimeoutPaths.join(","),
                ),
              };
              const pattern = new RegExp(
                `\\b(${Object.keys(tokens).join("|")})\\b`,
                "g",
              );
              return {
                code: code.replace(
                  pattern,
                  (key) => tokens[/** @type {keyof typeof tokens} */ (key)],
                ),
                map: null,
              };
            },
          },
        ],
      },
    },

    // Runs in `vite dev`, `vite preview` and prerender, so it must stay free of
    // side effects. There is no Bun server or original request outside the
    // production runtime; `setRequestTimeout` is always callable.
    emulate() {
      return {
        platform: () => ({
          bun: {
            setRequestTimeout() {},
          },
        }),
      };
    },

    supports: {
      read: () => true,
      instrumentation: () => true,
    },
  };
}

/**
 * Build-owned relative paths, excluding dotfiles except root .well-known.
 * Compressed twins exist only when Kit compressed the corresponding file.
 * @param {string[]} paths
 * @param {string} base
 * @param {string[]} compressed
 */
function servableAssets(paths, base, compressed) {
  const variants = new Set(compressed);
  return paths
    .filter(
      (path) =>
        !path
          .split("/")
          .some(
            (segment, index) =>
              segment.startsWith(".") &&
              !(index === 0 && segment === ".well-known"),
          ),
    )
    .flatMap((path) => {
      const rooted = `${base.slice(1)}${base ? "/" : ""}${path}`;
      return [
        rooted,
        ...(variants.has(path) ? [rooted + ".br", rooted + ".gz"] : []),
      ];
    });
}

/**
 * Default `compile.assets`: embed the static trees the runtime serves so the
 * binary is self-contained. A missing directory makes Bun.build fail.
 *
 * @param {string} out
 * @returns {string[]}
 */
function defaultCompileAssets(out) {
  return [`${out}/client`, `${out}/prerendered`].filter((dir) =>
    existsSync(dir),
  );
}

/**
 * @param {{ out: string; compile: true | CompileOptions }} params
 */
async function compileEntrypoint({ out, compile }) {
  if (typeof Bun === "undefined") {
    throw new Error(
      "The compile option requires running the adapter under Bun.",
    );
  }

  const options = compile === true ? {} : compile;
  const {
    target,
    outfile = `${out}/app`,
    bytecode = true,
    minify = true,
    sourcemap = "linked",
    assets = defaultCompileAssets(out),
    execArgv,
    // Production binaries must not pick up a stray .env or bunfig.toml from
    // the working directory. Bun defaults both to true.
    autoloadDotenv = false,
    autoloadBunfig = false,
  } = options;

  /** @type {BunCompileBuildOptions} */
  const compileOptions = {
    outfile,
    assets,
    autoloadDotenv,
    autoloadBunfig,
    // An explicit `target: undefined` makes Bun reject the build.
    ...(target ? { target } : {}),
    ...(execArgv ? { execArgv } : {}),
  };

  try {
    await Bun.build({
      entrypoints: [`${out}/index.js`],
      target: "bun",
      // Bytecode defaults to CommonJS, which cannot hold the runtime's
      // top-level await. ESM bytecode requires compile, which is set here.
      format: "esm",
      compile: compileOptions,
      bytecode,
      minify,
      sourcemap,
    });
  } catch (error) {
    throw new Error(`Bun compile failed:\n${buildErrorMessages(error)}`, {
      cause: error,
    });
  }
}

/**
 * Bun.build rejects with an AggregateError of BuildMessages, or a plain error
 * (for example an invalid compile target).
 *
 * @param {unknown} error
 * @returns {string}
 */
function buildErrorMessages(error) {
  const aggregate = /** @type {{ errors?: unknown } | null | undefined} */ (
    error
  );
  const entries = Array.isArray(aggregate?.errors) ? aggregate.errors : [error];
  return entries
    .map((entry) =>
      String(
        /** @type {{ message?: unknown } | null | undefined} */ (entry)
          ?.message ?? entry,
      ),
    )
    .join("\n");
}
