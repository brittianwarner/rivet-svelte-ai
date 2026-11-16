# @example/sveltekit-adapter-bun

Bun-native SvelteKit adapter for Railway deployments.

It keeps the official node adapter's SvelteKit build contract, but emits a
runtime that uses Bun's current server primitives for better performance and
streaming behavior.

## Why

`@sveltejs/adapter-node` is reliable, but its runtime is a Node HTTP server
stack. Running that stack on Bun still pays for Node compatibility layers:
`node:http`, Polka, Sirv, and request/response conversion through
`@sveltejs/kit/node`.

This adapter preserves what works from adapter-node and replaces the runtime
implementation with:

- `Bun.serve`
- exact static/prerendered paths registered in `Bun.serve({ routes })`
- `Accept: text/markdown` negotiation when a prerendered sibling `.md` exists
  (`Vary: Accept, Accept-Encoding`; HTML-only apps unchanged)
- `Bun.file`
- startup-precomputed file metadata (no file bytes are read at startup) and reusable `Bun.file` handles on static/prerendered hot paths
- Bun's native Range handling on `Response(Bun.file)` bodies (206, 416, sendfile)
- Web `Request` and `Response`
- Bun `maxRequestBodySize`
- Bun `idleTimeout` and `server.timeout(request, seconds)`
- Bun `server.requestIP(request)`

## Usage

```js
// vite.config.js
import adapter from "@example/sveltekit-adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        bodySizeLimit: "1200000000",
        idleTimeout: 255,
        noIdleTimeoutPaths: ["/api/rivet", "/api/mcp"],
      }),
    }),
  ],
});
```

Run the emitted server with Bun:

```bash
bun ./build/index.js
```

## Options

| Option               | Default                      | Description                                                   |
| -------------------- | ---------------------------- | ------------------------------------------------------------- |
| `out`                | `"build"`                    | Output directory                                              |
| `precompress`        | `true`                       | Run SvelteKit gzip/brotli compression for assets              |
| `envPrefix`          | `""`                         | Prefix for runtime env vars                                   |
| `serveAssets`        | `true`                       | Serve client/prerendered files before SSR                     |
| `bodySizeLimit`      | `"1200000000"`               | Default `BODY_SIZE_LIMIT` / Bun `maxRequestBodySize`          |
| `idleTimeout`        | `255`                        | Default Bun idle timeout in seconds                           |
| `noIdleTimeoutPaths` | `["/api/rivet", "/api/mcp"]` | Prefixes that call `server.timeout(request, 0)` automatically |
| `compile`            | `false`                      | Experimental Bun standalone executable build (see below)      |

### `compile` (experimental)

`compile: true` (or an options object) also emits a Bun standalone executable.
The default outfile is `<out>/app` (`build/app`); it used to be `<out>/server`,
which is now the server bundle directory, not the binary. Deploy `build/app`.

| `compile` field  | Default                             | Description                                                |
| ---------------- | ----------------------------------- | ---------------------------------------------------------- |
| `target`         | host                                | Bun compile target, e.g. `bun-linux-x64-modern`            |
| `outfile`        | `<out>/app`                         | Executable path                                            |
| `bytecode`       | `true`                              | Bun bytecode                                               |
| `minify`         | `true`                              | Minify the executable input                                |
| `sourcemap`      | `"linked"`                          | `none`, `linked`, `external` or `inline`                   |
| `assets`         | `<out>/client`, `<out>/prerendered` | Files embedded in the binary; a value replaces the default |
| `execArgv`       | none                                | Runtime arguments baked into the binary                    |
| `autoloadDotenv` | `false`                             | Load `.env` from the working directory (Bun defaults true) |
| `autoloadBunfig` | `false`                             | Load `bunfig.toml` from the working directory (Bun: true)  |

The client and prerendered files are embedded by default, so the binary serves
static assets from any working directory. `.env` and `bunfig.toml` autoloading
is off so a production binary never picks up a stray file; set the options to
`true` to opt back in.

The compile step needs the adapter itself to run under Bun:

```bash
bun --bun vite build   # plain `bun x vite build` runs vite under Node and fails
./build/app
```

A failed compile throws `Bun compile failed:` with the Bun build messages and
the original error as `cause`. Inside the binary every file gets a content-hash
ETag and `Last-Modified` is omitted (embedded files have no mtime).

## Runtime Env Vars

The generated runtime supports the adapter-node env contract plus one
Bun-specific streaming helper:

- `HOST` (defaults to `::` for dual stack binding)
- `PORT`
- `SOCKET_PATH`
- `ORIGIN` (compatibility fallback; Kit 3 `paths.origin` takes precedence)
- `BODY_SIZE_LIMIT`
- `ADDRESS_HEADER`
- `XFF_DEPTH` (validated at startup: a non-integer value fails boot)
- `PROTOCOL_HEADER`
- `HOST_HEADER`
- `PORT_HEADER`
- `SHUTDOWN_TIMEOUT`
- `IDLE_TIMEOUT`
- `NO_IDLE_TIMEOUT_PATHS`

`BODY_SIZE_LIMIT` accepts raw bytes, `B`, `K`, `M`, and `G` suffixes (any
case; fractions are floored, so `1.5M` is 1572864), or `Infinity` for no limit
(SvelteKit recommends `Infinity` over `0`).

`IDLE_TIMEOUT`, `SHUTDOWN_TIMEOUT`, `BODY_SIZE_LIMIT` and `XFF_DEPTH` are
validated at startup; an invalid value stops boot with an error naming the
(prefixed) variable. `IDLE_TIMEOUT` is Bun's per-connection idle timeout in
seconds, an integer from 0 to 255. In adapter-node the same name is the
socket-activation idle-shutdown delay, a different thing.

`KEEP_ALIVE_TIMEOUT` and `HEADERS_TIMEOUT` (prefixed) are accepted but
ignored, because `Bun.serve` has no equivalent; setting either logs one startup
warning. With an empty `envPrefix` the bare names warn too.

## Errors and shutdown

`Bun.serve` always runs with `development: false`. A fault in the adapter
itself is logged and answered with a bare `text/plain` 500
`Internal Server Error`, whatever `NODE_ENV` is. SvelteKit's own error pages
are unaffected. A malformed `Host` header gets a plain-text 400.

- The first SIGINT/SIGTERM stops the server gracefully and logs the pending
  request count.
- After `SHUTDOWN_TIMEOUT` seconds open connections are force-closed, but the
  process does not exit (same as adapter-node).
- A second SIGINT/SIGTERM force-closes, emits `sveltekit:shutdown` and exits
  with code 1.

Close DB pools, intervals and other handles in a listener:

```js
process.on("sveltekit:shutdown", async (reason) => {
  await db.end();
});
```

## Static files and caching

- Static and prerendered files are served by Bun's native `routes` table for
  GET and HEAD; other methods fall through to SvelteKit. Paths containing `*`
  or a segment starting with `:` are served by the fallback handler instead.
- Reserved filename characters (`?`, `#`, and percent literals) work with
  either case of URL escapes. Asset lookups decode each segment once and
  reject encoded separators, NUL, dot segments, and malformed escapes; hidden
  and unlisted files remain private. SvelteKit receives the original URL.
- `/_app/immutable/` assets (including under `paths.base`) get
  `Cache-Control: public,max-age=31536000,immutable` and a weak
  `W/"size-mtime"` ETag.
- Every other file gets a strong content ETag, `"<xxhash3>-<size hex>"`,
  computed on first request.
- Conditional GET follows RFC 9110: `If-None-Match` (lists, weak tags and `*`)
  is checked first, and `If-Modified-Since` only when it is absent (whole
  seconds).
- `If-Range` is honored: a matching strong ETag or exact `Last-Modified` gets
  the range, anything else (any weak tag) gets the full 200.
- `Accept-Encoding` negotiation respects `q=0` and `*`. A direct request for a
  `.br`/`.gz` file returns the decoded file's content type with no
  `Content-Encoding`.

## Platform

Server routes can use Bun-specific controls through SvelteKit's platform
object:

```ts
export const GET = ({ platform }) => {
  platform?.bun?.setRequestTimeout(0);
  return new Response("streaming response");
};
```

Available fields:

- `platform.bun.setRequestTimeout(seconds)`: always present; a no-op in
  `vite dev`, `vite preview` and prerender (`adapter.emulate()`).
- `platform.bun.server` (optional): production runtime only, `undefined` under
  `emulate()`. Guard it: `platform?.bun?.server?.requestIP(request)`.
- `platform.bun.request` (optional): production runtime only.
- `platform.server` / `platform.request`: deprecated aliases of the two above,
  production runtime only.

## Streaming responses

- A `text/event-stream` response from SvelteKit gets `X-Accel-Buffering: no` so nginx-style
  proxies do not buffer it. A value the app sets itself is kept.
- Under Bun a HEAD response body is cancelled at once (adapter-node drains
  it). A streaming endpoint that enqueues from a timer or callback must stop
  in `cancel()` (or guard the enqueue): an enqueue on the closed controller
  throws outside the request and exits the process.

```js
let timer;
const stream = new ReadableStream({
  start(controller) {
    timer = setInterval(() => controller.enqueue(chunk()), 1000);
  },
  cancel() {
    clearInterval(timer);
  },
});
```

## Embedding in one server

The build also writes `build/handler.js`. It exports `getHandler()`, which
returns `{ fetch, routes }` without starting a server. `apps/server` uses it to
serve the web app from the same `Bun.serve` as the API and the Rivet gateway:

```ts
import { getHandler } from "../web/build/handler.js";
const web = getHandler({ noIdleTimeoutPaths: ["/rivet"] });
Bun.serve({ routes: { ...web.routes, "/api/*": api, "/rivet/*": gateway }, fetch: web.fetch });
```

## Tests

`bun test tests` covers option validation, content negotiation and static
serving. The adapter-node parity harness, fixtures and benchmarks stay in the
upstream copy this package was taken from.

## Bun Docs Used

The runtime design follows current Bun docs for:

- File I/O: `Bun.file`, lazy files, streaming file responses
- HTTP server: `Bun.serve`, `routes`, `idleTimeout`, `server.timeout`, `server.stop`, `server.requestIP`
- Fetch and streams: Web `Request`, `Response`, `ReadableStream`, streaming request/response bodies
- Environment variables: `Bun.env`
- Binary data: `Blob`, `BunFile`, typed arrays
- DNS/networking: app-level code can keep using Bun DNS prefetch/probes; the adapter does not hide them
- CSRF/secrets/cookies: SvelteKit keeps owning framework-level CSRF, cookies, and secrets behavior

Not every Bun API belongs in a SvelteKit adapter. TCP, UDP, DNS, secrets,
Markdown, HTMLRewriter, JSON5, semver, color utilities, and raw WebSocket
server APIs are intentionally left to application code or SvelteKit because the
adapter's job is to host SvelteKit's `Server.respond()` output correctly.

## Known Non-Parity

Intentional differences from adapter-node and sirv:

- `txt`, `css`, `js` and `mjs` are served with `;charset=utf-8`.
- Reversed (`bytes=5-2`), multi-range and non-`bytes` Range requests get the
  full 200 (RFC 9110 lets servers ignore them); sirv returns 416 for reversed
  ranges. Unsatisfiable ranges still get 416, with Bun's `Accept-Ranges`.
- `Vary: Accept-Encoding` is sent on identity responses whenever a `.br`/`.gz`
  sibling exists (sirv does the same).
- Non-GET/HEAD requests to static paths reach SvelteKit; sirv serves the file.
- Redirect `Location` values are percent-encoded (`/blog/%C3%BCber`, where
  adapter-node sends the raw path).
- Reserved-character static filenames (`?`, `#`, percent literals, including
  colon/wildcard fallback combinations) are served from the build-owned index;
  adapter-node/Sirv returns 404 for these URL spellings.
- An invalid `XFF_DEPTH` fails boot instead of failing each request.
- A HEAD response body is cancelled rather than drained (see Streaming).
- systemd socket activation (`LISTEN_PID` / `LISTEN_FDS`) is not supported, by
  choice: `Bun.serve` has no inherited-fd option, and `node:net`
  `listen({ fd })` would bring back the Node server stack this adapter
  replaces. Use `SOCKET_PATH` for Unix-socket deployments.

Considered and not adopted: HTTP/2 and HTTP/3 (experimental in Bun and need
TLS), response compression (`Bun.serve` has none; precompression covers
assets), zstd precompression, `Bun.build` as the server bundler, a second server rebundling pass, and native Bun file routes for immutable assets (they ignore
`If-Range`).

## Notes

The optional `compile` path uses Bun standalone executables and bytecode. It
works, but stays experimental and off by default: large SvelteKit apps with
actor runtimes and dynamic workspace dependencies need deployment-specific
validation before relying on a single binary.

`@sveltejs/kit` ^3.0.0 is the peer dependency. Configure the adapter through
`sveltekit({...})` in `vite.config.js`; Kit 3 no longer loads `svelte.config.js`.

The adapter joins Vite's existing Rolldown SSR graph, sharing app modules and
Svelte library export conditions. Kit's `generateServerInstance` creates the
server. Generated `index.js` and `handler.js` re-export their bundled server
entries, while `adapter-bun.js` supplies the instance, paths, and build-owned
asset lists. Runtime serving keeps reusable `Bun.file` handles and reads no
asset bytes at startup. Only assets listed by the build can be served;
additional files placed in the output directory remain private. Dotfiles are
excluded except root `.well-known`, whose nested dotfiles remain private.

Instrumentation initializes `$app/env/private` from `Bun.env` before
loading `instrumentation.server.js`, then loads the application graph.
