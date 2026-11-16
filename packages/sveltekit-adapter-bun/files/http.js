/**
 * Pure HTTP helpers for the static and prerendered lanes of handler.js.
 *
 * Nothing here touches the SvelteKit build output, so every helper is
 * unit-testable without building an app. Keep build-time replacement tokens
 * (the upper-case globals handler.js uses) out of this file: builder.copy
 * rewrites them as whole words in every copied file.
 */

/** Route keys Bun's router would read as a param (`:x`) or a wildcard (`*`). */
const ROUTER_SYNTAX = /(^|\/):|\*/;

/**
 * Percent-encode a decoded pathname for a URL or a Bun route key.
 * `encodeURI` leaves `?` and `#` alone, which would end the path early.
 * Returns undefined for input `encodeURI` rejects (lone surrogates).
 *
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function encodePathname(pathname) {
  try {
    return encodeURI(pathname).replace(/[?#]/g, encodeURIComponent);
  } catch {
    return undefined;
  }
}

/**
 * Bun route key for a decoded static or prerendered pathname, or undefined
 * when the path must be served by the fetch fallback instead: `:` at a segment
 * start and `*` are router syntax, and an unencodable path cannot be a key.
 *
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function routeKey(pathname) {
  if (ROUTER_SYNTAX.test(pathname)) return undefined;
  return encodePathname(pathname);
}

/**
 * Parse a q-value parameter. Missing or malformed values count as 1.
 *
 * @param {string[]} params
 * @returns {number}
 */
function qValue(params) {
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== "q") continue;
    const parsed = Number(param.slice(eq + 1).trim());
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1;
  }
  return 1;
}

/**
 * True when an Accept-Encoding header accepts `encoding` with q > 0.
 * An explicit entry wins over `*`; `q=0` refuses (RFC 9110 §12.5.3).
 *
 * @param {{ header: string | null | undefined; encoding: 'br' | 'gzip' }} params
 * @returns {boolean}
 */
export function acceptsEncoding({ header, encoding }) {
  if (!header) return false;

  /** @type {number | undefined} */
  let wildcard;
  for (const raw of header.split(",")) {
    const parts = raw.split(";");
    const token = (parts[0] ?? "").trim().toLowerCase();
    if (token === encoding) return qValue(parts.slice(1)) > 0;
    if (token === "*") wildcard = qValue(parts.slice(1));
  }
  return wildcard !== undefined && wildcard > 0;
}

/** @param {string} tag */
function opaqueTag(tag) {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

/** @param {string} tag */
function isWeakTag(tag) {
  return tag.trim().startsWith("W/");
}

/**
 * If-None-Match with weak comparison (RFC 9110 §13.1.2): a comma-separated
 * list, `W/` ignored on both sides, `*` matches any current representation.
 *
 * @param {{ header: string; etag: string }} params
 * @returns {boolean}
 */
export function ifNoneMatchMatches({ header, etag }) {
  const current = opaqueTag(etag);
  for (const candidate of header.split(",")) {
    const trimmed = candidate.trim();
    if (trimmed === "*") return true;
    if (trimmed && opaqueTag(trimmed) === current) return true;
  }
  return false;
}

/**
 * Whole-second view of an mtime, matching the precision of an HTTP date.
 *
 * @param {number} mtimeMs
 * @returns {number}
 */
export function httpDateMs(mtimeMs) {
  return Math.floor(mtimeMs / 1000) * 1000;
}

/**
 * Conditional GET evaluation for a file (RFC 9110 §13.1.3 precedence).
 * If-Modified-Since is ignored when If-None-Match is present, and when the
 * entry has no usable mtime (0, as in a compiled binary's embedded files).
 *
 * @param {{ ifNoneMatch: string | null; ifModifiedSince: string | null; etag: string; mtimeMs: number }} params
 * @returns {boolean} true when the response should be 304 Not Modified
 */
export function isNotModified({ ifNoneMatch, ifModifiedSince, etag, mtimeMs }) {
  if (ifNoneMatch !== null)
    return ifNoneMatchMatches({ header: ifNoneMatch, etag });
  if (!ifModifiedSince || mtimeMs === 0) return false;

  const since = Date.parse(ifModifiedSince);
  return Number.isFinite(since) && httpDateMs(mtimeMs) <= since;
}

/**
 * If-Range evaluation (RFC 9110 §13.1.5). An entity tag must match with
 * strong comparison, so a weak tag never does. A date must equal
 * Last-Modified exactly. Anything else means "send the full representation".
 *
 * @param {{ header: string; etag: string; lastModified: string | undefined }} params
 * @returns {boolean} true when the Range header may be honoured
 */
export function ifRangeMatches({ header, etag, lastModified }) {
  const value = header.trim();
  if (value.startsWith('"') || value.startsWith("W/")) {
    return !isWeakTag(value) && !isWeakTag(etag) && value === etag.trim();
  }
  if (!lastModified) return false;
  const date = Date.parse(value);
  return Number.isFinite(date) && date === Date.parse(lastModified);
}

/**
 * Strong content ETag for a file, hashed in fixed-size slices with a chained
 * seed so memory stays bounded and the tag is stable across builds and
 * replicas with identical bytes.
 *
 * @param {{ file: import("bun").BunFile; size: number; chunkSize?: number }} params
 * @returns {Promise<string>}
 */
export async function contentEtag({ file, size, chunkSize = 4 * 1024 * 1024 }) {
  /** @type {bigint} */
  let hash = 0n;
  if (size === 0) {
    hash = Bun.hash.xxHash3(new Uint8Array(0));
  }
  for (let offset = 0; offset < size; offset += chunkSize) {
    const bytes = await file.slice(offset, offset + chunkSize).bytes();
    hash = Bun.hash.xxHash3(bytes, hash);
  }
  return `"${hash.toString(16)}-${size.toString(16)}"`;
}

/** @type {Record<string, string>} */
export const MIME_TYPES = {
  avif: "image/avif",
  css: "text/css;charset=utf-8",
  gif: "image/gif",
  html: "text/html;charset=utf-8",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  js: "text/javascript;charset=utf-8",
  json: "application/json",
  map: "application/json",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript;charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain;charset=utf-8",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

/** @param {string} path */
function extension(path) {
  const slash = path.lastIndexOf("/");
  const index = path.lastIndexOf(".");
  return index <= slash ? "" : path.slice(index + 1).toLowerCase();
}

/**
 * @param {string} path
 * @returns {string}
 */
export function stripEncodingExtension(path) {
  return path.endsWith(".br") || path.endsWith(".gz")
    ? path.slice(0, path.lastIndexOf("."))
    : path;
}

/**
 * Content-Type for `path` (a public path). The adapter table wins, then Bun's
 * own lookup for the file with any `.br`/`.gz` suffix removed from `abs`.
 *
 * @param {{ path: string; abs: string }} params
 * @returns {string}
 */
export function contentTypeFor({ path, abs }) {
  const mapped = MIME_TYPES[extension(path)];
  if (mapped) return mapped;

  const bunType = Bun.file(stripEncodingExtension(abs)).type;
  if (bunType) {
    return bunType === "text/html" ? "text/html;charset=utf-8" : bunType;
  }

  return "application/octet-stream";
}

/**
 * Ask reverse proxies (nginx and friends) not to buffer a server-sent event
 * stream. Leaves an explicit app-set value alone.
 *
 * @param {Response} response
 * @returns {Response}
 */
export function markEventStreamUnbuffered(response) {
  const type = response.headers.get("content-type");
  if (
    type &&
    type.toLowerCase().startsWith("text/event-stream") &&
    !response.headers.has("x-accel-buffering")
  ) {
    try {
      response.headers.set("x-accel-buffering", "no");
    } catch {
      // Immutable headers (a re-used fetch() Response): leave as is.
    }
  }
  return response;
}

/**
 * `Link: <path>; rel="alternate"; type="text/markdown"` for a public path.
 *
 * @param {string} publicPath decoded public path of the `.md` file
 * @returns {string | undefined}
 */
export function markdownAlternateLink(publicPath) {
  const encoded = encodePathname(publicPath);
  return encoded
    ? `<${encoded}>; rel="alternate"; type="text/markdown"`
    : undefined;
}

/**
 * 308 Location for a decoded pathname plus the raw query string (with `?`).
 *
 * @param {{ pathname: string; search: string }} params
 * @returns {string | undefined}
 */
export function redirectLocation({ pathname, search }) {
  const encoded = encodePathname(pathname);
  return encoded === undefined ? undefined : `${encoded}${search}`;
}
