import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  server,
  dir,
  appPath,
  origin as configuredOrigin,
  clientAssets,
  prerenderedAssets,
  prerendered,
  base,
} from "#@example/sveltekit-adapter-bun";
import { env, nonNegativeIntegerEnv } from "./env.js";
import {
  setMarkdownVary,
  markdownSiblingPaths,
  prefersMarkdown,
} from "./accept-negotiation.js";
import {
  acceptsEncoding,
  contentEtag,
  contentTypeFor,
  ifRangeMatches,
  isNotModified,
  markdownAlternateLink,
  markEventStreamUnbuffered,
  redirectLocation,
  routeKey,
  stripEncodingExtension,
} from "./http.js";

/* global ENV_PREFIX */
/* global PRECOMPRESS */
/* global SERVE_ASSETS */

// Kit 3 config is canonical; retain ORIGIN for existing Railway deployments.
const origin = parseOrigin(configuredOrigin ?? env("ORIGIN", undefined));
// Validated at startup so a typo (XFF_DEPTH=abc) fails boot naming the
// variable, instead of every getClientAddress() silently returning "".
// 0 still parses and keeps adapter-node's per-request error below.
const xffDepth = nonNegativeIntegerEnv("XFF_DEPTH", 1);
const addressHeader = String(env("ADDRESS_HEADER", "")).toLowerCase();
const protocolHeader = String(env("PROTOCOL_HEADER", "")).toLowerCase();
const hostHeader = String(env("HOST_HEADER", "")).toLowerCase();
const portHeader = String(env("PORT_HEADER", "")).toLowerCase();

const clientRoot = `${dir}/client`;
const prerenderedRoot = `${dir}/prerendered`;
const assetDir = `${clientRoot}${base}`;
const immutablePrefix = `${base}/${appPath}/immutable/`;
/**
 * Embedded files in a `bun build --compile` binary report mtime 0, so their
 * size-mtime tags collide across builds. `isStandaloneExecutable` is absent
 * from older bun-types, hence the reflective read.
 */
const standalone = Reflect.get(Bun, "isStandaloneExecutable") === true;

await server.init({
  env: Bun.env,
  /** @param {string} file */
  read: (file) => Bun.file(`${assetDir}/${file}`).stream(),
});

const clientFiles = SERVE_ASSETS
  ? createFileIndex({ root: clientRoot, assets: clientAssets, immutablePrefix })
  : undefined;
const prerenderedFiles = SERVE_ASSETS
  ? createFileIndex({ root: prerenderedRoot, assets: prerenderedAssets })
  : undefined;

/**
 * @typedef {(request: Request, server: import('bun').Server<undefined>) => Promise<Response> | Response} RouteHandler
 * @typedef {{ GET: RouteHandler; HEAD: RouteHandler }} RouteValue
 */

/**
 * @param {{ noIdleTimeoutPaths?: string[] }} options
 */
function getHandler(options = {}) {
  const noIdleTimeoutPaths = options.noIdleTimeoutPaths ?? [];

  /**
   * @param {Request} request
   * @param {import('bun').Server<undefined>} bunServer
   */
  const fetch = async (request, bunServer) => {
    /** @type {URL} */
    let url;
    try {
      url = new URL(request.url);
    } catch {
      // A malformed Host header makes request.url unparsable.
      return badRequest();
    }
    const pathname = decodePathname(url.pathname);
    const assetPathname = decodeAssetPathname(url.pathname);

    if (matchesPrefix(pathname, noIdleTimeoutPaths)) {
      bunServer.timeout(request, 0);
    }

    if (clientFiles && assetPathname !== undefined) {
      const staticResponse = serveStatic({
        request,
        pathname: assetPathname,
        index: clientFiles,
        client: true,
      });
      if (staticResponse) return staticResponse;
    }

    if (prerenderedFiles && assetPathname !== undefined) {
      const prerenderedResponse = servePrerendered({
        request,
        pathname: assetPathname,
        url,
      });
      if (prerenderedResponse) return prerenderedResponse;
    }

    return ssr({ request, bunServer, pathname, url });
  };

  return {
    fetch,
    routes: createRoutes({ fetch }),
  };
}

function badRequest() {
  return new Response("Bad Request", {
    status: 400,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

/**
 * Bun's native router gives exact static asset and prerendered paths a fast
 * tree lookup; the fetch fallback keeps full SvelteKit semantics. Routes are
 * per-method, so any method other than GET/HEAD reaches `fetch` natively.
 *
 * @param {{ fetch: RouteHandler }} params
 */
function createRoutes({ fetch }) {
  /** @type {Record<string, RouteValue>} */
  const routes = {};
  /**
   * @param {string} pathname decoded public path
   * @param {() => RouteValue | undefined} create
   */
  const add = (pathname, create) => {
    // Unencodable paths and paths with router syntax (`:` segment starts,
    // `*`) are left to the fetch fallback, which decodes and serves them.
    const key = routeKey(pathname);
    if (key === undefined || key in routes) return;
    const value = create();
    if (value) routes[key] = value;
  };

  if (clientFiles) {
    for (const pathname of clientFiles.files.keys()) {
      // Native Bun file routes for sibling-less immutable assets (plan A12)
      // were measured and not adopted: ~12-19% faster on those paths alone,
      // but no app in this repo or the fixture has such an asset (precompress
      // covers every immutable file), and Bun's file routes ignore If-Range.
      add(pathname, () =>
        createKnownStaticRoute({
          pathname,
          index: clientFiles,
          client: true,
          fallback: fetch,
        }),
      );
    }
  }

  if (prerenderedFiles) {
    for (const pathname of prerendered) {
      add(pathname, () =>
        createKnownStaticRoute({
          pathname,
          index: prerenderedFiles,
          fallback: fetch,
        }),
      );
      const redirectPath = pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : `${pathname}/`;
      add(redirectPath, () =>
        createKnownPrerenderRedirectRoute({ location: pathname }),
      );
    }
  }

  return routes;
}

/**
 * @param {RouteHandler} handler
 * @returns {RouteValue}
 */
function getAndHead(handler) {
  return { GET: handler, HEAD: handler };
}

/**
 * @param {{ pathname: string; index: FileIndex; client?: boolean; fallback: RouteHandler }} params
 * @returns {RouteValue | undefined}
 */
function createKnownStaticRoute({ pathname, index, client = false, fallback }) {
  const candidates = createKnownFileCandidates({ index, pathname });
  if (candidates.length === 0) return undefined;

  return getAndHead((request, bunServer) => {
    const negotiated = negotiatePrerenderedMatch({
      request,
      pathname,
      index,
      candidates,
      acceptedEncodings: request.headers.get("accept-encoding") ?? "",
      client,
    });
    // Only a path whose sole file is a refused .br/.gz twin gets here.
    return negotiated ? fileResponse(negotiated) : fallback(request, bunServer);
  });
}

/**
 * @param {{ location: string }} params
 * @returns {RouteValue | undefined}
 */
function createKnownPrerenderRedirectRoute({ location: baseLocation }) {
  const encoded = redirectLocation({ pathname: baseLocation, search: "" });
  if (encoded === undefined) return undefined;

  return getAndHead((request) => {
    const queryIndex = request.url.indexOf("?");
    const location =
      queryIndex === -1
        ? encoded
        : `${encoded}${request.url.slice(queryIndex)}`;
    return new Response(null, { status: 308, headers: { location } });
  });
}

/**
 * @param {{ request: Request; pathname: string; index: FileIndex; client?: boolean }} params
 */
function serveStatic({ request, pathname, index, client = false }) {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;

  const acceptedEncodings = request.headers.get("accept-encoding") ?? "";
  const candidates = client
    ? undefined
    : createKnownFileCandidates({ index, pathname });
  const negotiated = negotiatePrerenderedMatch({
    request,
    pathname,
    index,
    candidates,
    acceptedEncodings,
    client,
  });
  return negotiated ? fileResponse(negotiated) : undefined;
}

/**
 * @param {{ request: Request; pathname: string; url: URL }} params
 */
function servePrerendered({ request, pathname, url }) {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;

  if (prerendered.has(pathname)) {
    return prerenderedFiles
      ? serveStatic({ request, pathname, index: prerenderedFiles })
      : undefined;
  }

  const target = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : `${pathname}/`;
  if (prerendered.has(target)) {
    const location = redirectLocation({ pathname: target, search: url.search });
    if (location === undefined) return undefined;
    return new Response(null, { status: 308, headers: { location } });
  }

  return undefined;
}

/**
 * @param {{ request: Request; bunServer: import('bun').Server<undefined>; pathname: string; url: URL }} params
 */
async function ssr({ request, bunServer, url }) {
  let normalizedRequest;
  try {
    const baseOrigin = origin || getOrigin(request.headers);
    // Rebuild only the URL (Kit's CSRF/origin checks need ORIGIN or the proxy
    // headers); Bun clones method, headers, body and abort signal natively.
    const target = `${baseOrigin}${url.pathname}${url.search}`;
    normalizedRequest = new Request(target, request);
  } catch {
    return badRequest();
  }

  const response = await server.respond(normalizedRequest, {
    platform: {
      bun: {
        server: bunServer,
        request,
        /** @param {number} seconds */
        setRequestTimeout(seconds) {
          bunServer.timeout(request, seconds);
        },
      },
      server: bunServer,
      request,
    },
    getClientAddress() {
      if (addressHeader) {
        if (!request.headers.has(addressHeader)) {
          throw new Error(
            `Address header was specified with ${ENV_PREFIX + "ADDRESS_HEADER"}=${addressHeader} but is absent from request`,
          );
        }

        const value = request.headers.get(addressHeader) || "";
        if (addressHeader === "x-forwarded-for") {
          const addresses = value.split(",");
          if (xffDepth < 1) {
            throw new Error(
              `${ENV_PREFIX + "XFF_DEPTH"} must be a positive integer`,
            );
          }
          if (xffDepth > addresses.length) {
            throw new Error(
              `${ENV_PREFIX + "XFF_DEPTH"} is ${xffDepth}, but only found ${addresses.length} addresses`,
            );
          }
          return addresses[addresses.length - xffDepth]?.trim() || "";
        }

        return value;
      }

      return bunServer.requestIP(request)?.address || "";
    },
  });

  return markEventStreamUnbuffered(response);
}

/**
 * One file on disk, indexed at startup. `contentType` is the type when the
 * file is requested by its own path; `variantContentType` is the type of the
 * representation a `.br`/`.gz` file encodes.
 *
 * @typedef {{
 *   abs: string;
 *   urlPath: string;
 *   file: import('bun').BunFile;
 *   size: number;
 *   mtimeMs: number;
 *   lastModified: string | undefined;
 *   etag: string | undefined;
 *   pendingEtag: Promise<string> | undefined;
 *   contentType: string;
 *   variantContentType: string;
 * }} IndexEntry
 * @typedef {{ entry: IndexEntry; originalPath: string; encoding: 'br' | 'gzip' | undefined; contentType: string; varyEncoding: boolean }} FileEntry
 * @typedef {{ files: Map<string, IndexEntry> }} FileIndex
 * @typedef {{ br?: FileEntry; gzip?: FileEntry; identity?: FileEntry }} KnownFileCandidate
 */

/**
 * @param {{ index: FileIndex; pathname: string }} params
 * @returns {KnownFileCandidate[]}
 */
function createKnownFileCandidates({ index, pathname }) {
  return assumedPaths(pathname)
    .map((assumed) => {
      const varyEncoding = hasEncodedSibling({ index, path: assumed });
      return {
        br: fileEntryForPath({
          index,
          encodedPath: `${assumed}.br`,
          originalPath: assumed,
          encoding: /** @type {const} */ ("br"),
          varyEncoding,
        }),
        gzip: fileEntryForPath({
          index,
          encodedPath: `${assumed}.gz`,
          originalPath: assumed,
          encoding: /** @type {const} */ ("gzip"),
          varyEncoding,
        }),
        identity: fileEntryForPath({
          index,
          encodedPath: assumed,
          originalPath: assumed,
          encoding: undefined,
          varyEncoding,
        }),
      };
    })
    .filter(
      (candidate) => candidate.br || candidate.gzip || candidate.identity,
    );
}

/**
 * True when a negotiable `.br`/`.gz` twin exists for `path`, so every
 * response for it (identity included) must carry Vary: Accept-Encoding.
 *
 * @param {{ index: FileIndex; path: string }} params
 */
function hasEncodedSibling({ index, path }) {
  return (
    PRECOMPRESS &&
    (index.files.has(`${path}.br`) || index.files.has(`${path}.gz`))
  );
}

/**
 * @param {{ index: FileIndex; encodedPath: string; originalPath: string; encoding: 'br' | 'gzip' | undefined; varyEncoding: boolean }} params
 * @returns {FileEntry | undefined}
 */
function fileEntryForPath({
  index,
  encodedPath,
  originalPath,
  encoding,
  varyEncoding,
}) {
  const entry = index.files.get(encodedPath);
  return entry
    ? {
        entry,
        originalPath,
        encoding,
        contentType: encoding ? entry.variantContentType : entry.contentType,
        varyEncoding,
      }
    : undefined;
}

/**
 * @param {{ candidates: KnownFileCandidate[]; acceptedEncodings: string }} params
 * @returns {FileEntry | undefined}
 */
function selectKnownFileMatch({ candidates, acceptedEncodings }) {
  const wantsBr =
    PRECOMPRESS &&
    acceptsEncoding({ header: acceptedEncodings, encoding: "br" });
  const wantsGzip =
    PRECOMPRESS &&
    acceptsEncoding({ header: acceptedEncodings, encoding: "gzip" });

  for (const candidate of candidates) {
    if (wantsBr && candidate.br) return candidate.br;
    if (wantsGzip && candidate.gzip) return candidate.gzip;
    if (candidate.identity) return candidate.identity;
  }

  return undefined;
}

/**
 * @param {{ root: string; assets: string[]; immutablePrefix?: string }} params
 * @returns {FileIndex | undefined}
 */
function createFileIndex({ root, assets, immutablePrefix }) {
  if (!existsSync(root)) return undefined;
  /** @type {FileIndex} */
  const index = { files: new Map() };
  for (const rel of assets) {
    const abs = join(root, rel);
    // Compression skips some extensions, so a listed twin may be absent.
    if (!existsSync(abs)) continue;
    const stats = statSync(abs);
    if (!stats.isFile() || isHiddenPath(rel)) continue;
    const files = index.files;
    const urlPath = `/${rel.replace(/\\/g, "/")}`;
    const mtimeMs = stats.mtime.getTime();
    const immutable =
      immutablePrefix !== undefined && urlPath.startsWith(immutablePrefix);
    // Content-hashed immutable assets keep the cheap size-mtime tag. Every
    // other file gets a lazily computed content hash so 304s survive a
    // rebuild with unchanged bytes (and compiled binaries, where mtime is 0).
    const hashed = standalone || mtimeMs === 0 || !immutable;
    const decodedPath = stripEncodingExtension(urlPath);
    files.set(urlPath, {
      abs,
      urlPath,
      file: Bun.file(abs),
      size: stats.size,
      mtimeMs,
      lastModified: mtimeMs === 0 ? undefined : stats.mtime.toUTCString(),
      etag: hashed ? undefined : `W/"${stats.size}-${mtimeMs}"`,
      pendingEtag: undefined,
      contentType: contentTypeFor({ path: urlPath, abs }),
      variantContentType:
        decodedPath === urlPath
          ? contentTypeFor({ path: urlPath, abs })
          : contentTypeFor({ path: decodedPath, abs }),
    });
  }
  return index;
}

/**
 * Resolve (once) the content-hash ETag of an entry.
 *
 * @param {IndexEntry} entry
 * @returns {Promise<string>}
 */
function resolveEtag(entry) {
  if (entry.etag !== undefined) return Promise.resolve(entry.etag);
  entry.pendingEtag ??= contentEtag({
    file: entry.file,
    size: entry.size,
  }).then(
    (etag) => {
      entry.etag = etag;
      entry.pendingEtag = undefined;
      return etag;
    },
    (error) => {
      entry.pendingEtag = undefined;
      throw error;
    },
  );
  return entry.pendingEtag;
}

/** @param {string} rel */
function isHiddenPath(rel) {
  return rel
    .split(/[\\/]/)
    .some(
      (segment, index) =>
        segment.startsWith(".") &&
        !(
          segment === ".well-known" &&
          index === base.split("/").filter(Boolean).length
        ),
    );
}

/**
 * @param {{ index: FileIndex; pathname: string; acceptedEncodings: string }} params
 * @returns {FileEntry | undefined}
 */
function findFileMatch({ index, pathname, acceptedEncodings }) {
  return findFirstEntry({
    index,
    paths: assumedPaths(pathname),
    acceptedEncodings,
  });
}

/**
 * First indexed file among `paths`, trying accepted encodings per path.
 *
 * @param {{ index: FileIndex; paths: string[]; acceptedEncodings: string }} params
 * @returns {FileEntry | undefined}
 */
function findFirstEntry({ index, paths, acceptedEncodings }) {
  const encodings = acceptedContentEncodings(acceptedEncodings);

  for (const assumed of paths) {
    /** @type {boolean | undefined} */
    let varyEncoding;
    for (const encoding of encodings) {
      const encodedPath =
        encoding === "br"
          ? `${assumed}.br`
          : encoding === "gzip"
            ? `${assumed}.gz`
            : assumed;
      if (!index.files.has(encodedPath)) continue;
      varyEncoding ??= hasEncodedSibling({ index, path: assumed });
      const entry = fileEntryForPath({
        index,
        encodedPath,
        originalPath: assumed,
        encoding,
        varyEncoding,
      });
      if (entry) return entry;
    }
  }

  return undefined;
}

/** @param {string} header */
function acceptedContentEncodings(header) {
  /** @type {Array<'br' | 'gzip' | undefined>} */
  const encodings = [];
  if (PRECOMPRESS && acceptsEncoding({ header, encoding: "br" })) {
    encodings.push("br");
  }
  if (PRECOMPRESS && acceptsEncoding({ header, encoding: "gzip" })) {
    encodings.push("gzip");
  }
  encodings.push(undefined);
  return encodings;
}

/** @param {string} pathname */
function assumedPaths(pathname) {
  const uri =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const bases = uri === "" || uri === "/" ? ["/index"] : [uri, `${uri}/index`];
  /** @type {string[]} */
  const paths = [];

  for (const base of bases) {
    paths.push(base, `${base}.html`, `${base}.htm`);
  }

  return paths;
}

/**
 * When a prerendered HTML page has a sibling `.md`, honor Accept and
 * advertise the alternate. Client assets and HTML-only apps skip this.
 *
 * @param {{ request: Request; pathname: string; index: FileIndex; candidates?: KnownFileCandidate[]; acceptedEncodings: string; client: boolean }} params
 * @returns {{ request: Request; match: FileEntry; immutable: boolean; varyAccept: boolean; alternateLink?: string } | undefined}
 */
function negotiatePrerenderedMatch({
  request,
  pathname,
  index,
  candidates,
  acceptedEncodings,
  client,
}) {
  const immutable = client && pathname.startsWith(immutablePrefix);

  const markdownMatch = client
    ? undefined
    : findMarkdownSibling({ index, pathname, acceptedEncodings });

  if (markdownMatch && prefersMarkdown(request.headers.get("accept"))) {
    return { request, match: markdownMatch, immutable, varyAccept: true };
  }

  const match = candidates
    ? selectKnownFileMatch({ candidates, acceptedEncodings })
    : findFileMatch({ index, pathname, acceptedEncodings });
  if (!match) return undefined;

  return {
    request,
    match,
    immutable,
    varyAccept: Boolean(markdownMatch),
    // Advertise the `.md` file that actually exists (`/about/index.md` for a
    // trailing-slash page), not the first candidate name.
    alternateLink: markdownMatch
      ? markdownAlternateLink(markdownMatch.originalPath)
      : undefined,
  };
}

/**
 * @param {{ index: FileIndex; pathname: string; acceptedEncodings: string }} params
 * @returns {FileEntry | undefined}
 */
function findMarkdownSibling({ index, pathname, acceptedEncodings }) {
  if (pathname.endsWith(".md")) return undefined;
  return findFirstEntry({
    index,
    paths: markdownSiblingPaths(pathname),
    acceptedEncodings,
  });
}

/**
 * @typedef {{ request: Request; match: FileEntry; immutable: boolean; varyAccept?: boolean; alternateLink?: string }} FileResponseParams
 */

/**
 * @param {FileResponseParams} params
 * @returns {Response | Promise<Response>}
 */
function fileResponse(params) {
  const { entry } = params.match;
  if (entry.etag !== undefined)
    return buildFileResponse({ ...params, etag: entry.etag });
  return resolveEtag(entry).then((etag) =>
    buildFileResponse({ ...params, etag }),
  );
}

/**
 * @param {FileResponseParams & { etag: string }} params
 * @returns {Response}
 */
function buildFileResponse({
  request,
  match,
  immutable,
  varyAccept,
  alternateLink,
  etag,
}) {
  const { entry } = match;
  const headers = fileHeaders({
    match,
    etag,
    immutable,
    varyAccept,
    alternateLink,
  });

  if (
    isNotModified({
      ifNoneMatch: request.headers.get("if-none-match"),
      ifModifiedSince: request.headers.get("if-modified-since"),
      etag,
      mtimeMs: entry.mtimeMs,
    })
  ) {
    return new Response(null, { status: 304, headers });
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(entry.size));
    return new Response(null, { status: 200, headers });
  }

  const ifRange = request.headers.get("if-range");
  if (
    ifRange !== null &&
    request.headers.has("range") &&
    !ifRangeMatches({ header: ifRange, etag, lastModified: entry.lastModified })
  ) {
    // Stale validator: send the whole current file (RFC 9110 §13.1.5). Bun
    // ranges any file-backed body, including BunFile.stream(), and ignores
    // If-Range, so pipe through a TransformStream to opt out of auto-Range.
    return new Response(
      entry.file.stream().pipeThrough(new TransformStream()),
      {
        status: 200,
        headers,
      },
    );
  }

  // Bun answers Range on a BunFile body itself (206, 416, or 200 for
  // multi-range and invalid range sets) and rewrites Content-Length. On the
  // 206/416 it appends its own `accept-ranges: bytes`, so drop ours when Bun
  // will range the body, or the client sees `bytes, bytes`.
  if (willBunRange(request.headers.get("range"))) {
    headers.delete("accept-ranges");
  }
  headers.set("content-length", String(entry.size));
  return new Response(entry.file, { status: 200, headers });
}

/**
 * Whether Bun will answer this Range header with a 206 or 416 (and so add its
 * own `accept-ranges`). Bun ranges a single `bytes=` range; a set with a comma
 * or another unit gets the full 200 without the header. A malformed single
 * range (`bytes=5-2`) also gets a 200 from Bun and is classed as ranged here:
 * the header is then missing on that 200, which is harmless, never doubled.
 *
 * @param {string | null} range
 * @returns {boolean}
 */
function willBunRange(range) {
  return range !== null && /^\s*bytes\s*=[^,]*$/i.test(range);
}

/**
 * @param {{ match: FileEntry; etag: string; immutable: boolean; varyAccept?: boolean; alternateLink?: string }} params
 */
function fileHeaders({ match, etag, immutable, varyAccept, alternateLink }) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": match.contentType,
    etag,
  });
  if (match.entry.lastModified) {
    headers.set("last-modified", match.entry.lastModified);
  }

  if (match.encoding) headers.set("content-encoding", match.encoding);

  if (varyAccept) {
    setMarkdownVary(headers);
  } else if (match.encoding || match.varyEncoding) {
    headers.set("vary", "Accept-Encoding");
  }
  if (alternateLink) headers.set("link", alternateLink);

  if (immutable) {
    // Content-hashed assets under /_app/immutable/ — safe to cache forever.
    headers.set("cache-control", "public,max-age=31536000,immutable");
  } else {
    const contentType = match.contentType || "";
    if (contentType.startsWith("font/") || contentType.startsWith("image/")) {
      // Non-hashed static assets (static/ fonts, brand images, favicon): a
      // bounded TTL with background revalidation. Long enough to clear the
      // "efficient cache policy" heuristic, short enough that a redeploy that
      // changes these (their filenames don't rotate) is picked up within a day.
      headers.set(
        "cache-control",
        "public,max-age=86400,stale-while-revalidate=604800",
      );
    } else {
      // Prerendered HTML, __data.json, text/markdown mirrors, version.json:
      // always revalidate so a redeploy is served immediately. The content
      // etag above makes this a cheap 304 when nothing changed.
      headers.set("cache-control", "no-cache");
    }
  }

  return headers;
}

/** @param {string} pathname */
function decodePathname(pathname) {
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Decode URL segments once to match build-owned filename keys, including
 * reserved characters such as `?` and `#`. Encoded separators must not turn
 * into path structure, and malformed escapes must not match a literal key.
 * Keep this normalization in the asset lane: Kit receives the original URL.
 *
 * @param {string} pathname
 * @returns {string | undefined}
 */
function decodeAssetPathname(pathname) {
  // Ordinary application routes and hashed assets need no segment allocation.
  if (!pathname.includes("%")) return pathname;
  try {
    const segments = pathname.split("/").map(decodeURIComponent);
    if (
      segments.some((segment) =>
        /[/\\\0]/.test(segment) || segment === "." || segment === "..",
      )
    ) return undefined;
    return segments.join("/");
  } catch {
    return undefined;
  }
}

/**
 * @param {string} pathname
 * @param {string[]} prefixes
 */
function matchesPrefix(pathname, prefixes) {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function parseOrigin(value) {
  if (value === undefined) return undefined;

  const trimmed = String(value).trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error(
      `Invalid ORIGIN: '${trimmed}'. ORIGIN must be a valid URL with http:// or https:// protocol.`,
      { cause: error },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid ORIGIN: '${trimmed}'. Only http:// and https:// protocols are supported. Received protocol: ${parsed.protocol}`,
    );
  }

  return parsed.origin;
}

/**
 * @param {string} name
 * @param {string | null} value
 */
function normaliseHeader(name, value) {
  if (!name) return undefined;
  return value ?? undefined;
}

/** @param {Headers} headers */
function getOrigin(headers) {
  const protocol = decodeURIComponent(
    normaliseHeader(protocolHeader, readHeader(headers, protocolHeader)) ||
      "https",
  );

  if (protocol.includes(":")) {
    throw new Error(
      `The ${protocolHeader} header specified ${protocol} which is invalid because it includes ':'. It should only contain the protocol scheme (e.g. 'https')`,
    );
  }

  const host =
    normaliseHeader(hostHeader, readHeader(headers, hostHeader)) ||
    headers.get("host");
  if (!host) {
    const headerNames = hostHeader
      ? `${hostHeader} or host headers`
      : "host header";
    throw new Error(
      `Could not determine host. The request must have a value provided by the ${headerNames}`,
    );
  }

  const port = normaliseHeader(portHeader, readHeader(headers, portHeader));
  if (port && Number.isNaN(Number(port))) {
    throw new Error(
      `The ${portHeader} header specified ${port} which is an invalid port because it is not a number. The value should only contain the port number (e.g. 443)`,
    );
  }

  return port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
}

/**
 * @param {Headers} headers
 * @param {string} name
 */
function readHeader(headers, name) {
  if (!name) return null;
  return headers.get(name);
}

export { getHandler };
