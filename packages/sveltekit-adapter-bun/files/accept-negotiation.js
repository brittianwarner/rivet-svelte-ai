/**
 * Accept: text/markdown negotiation helpers for the prerendered fast lane.
 *
 * Used only when a sibling `.md` file exists so HTML-only apps (apps/web)
 * keep today's headers. Negotiated responses set Vary: Accept, Accept-Encoding.
 */

/**
 * @typedef {{ type: string; q: number; specificity: number }} AcceptEntry
 */

/**
 * Parse an Accept header into type + q + specificity entries.
 * Does not substring-match — q=0 and `text/html, text/markdown;q=0.1` stay correct.
 *
 * @param {string | null | undefined} header
 * @returns {AcceptEntry[]}
 */
export function parseAccept(header) {
  if (!header) return [];

  /** @type {AcceptEntry[]} */
  const entries = [];
  for (const raw of header.split(",")) {
    const parts = raw.trim().split(";").map((part) => part.trim());
    const type = (parts[0] ?? "").toLowerCase();
    if (!type) continue;

    let q = 1;
    for (const param of parts.slice(1)) {
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      const name = param.slice(0, eq).trim();
      const value = param.slice(eq + 1).trim();
      if (name === "q") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }

    const specificity = type === "*/*" ? 0 : type.endsWith("/*") ? 1 : 2;
    entries.push({ type, q, specificity });
  }
  return entries;
}

/**
 * @param {AcceptEntry} entry
 * @param {string} candidate
 */
function matches(entry, candidate) {
  if (entry.type === "*/*") return true;
  if (entry.type.endsWith("/*")) return candidate.startsWith(entry.type.slice(0, -1));
  return entry.type === candidate;
}

/**
 * Pick the highest-q type from `produces` that the Accept header allows.
 * Missing/empty Accept returns the first produce (HTML for this adapter).
 *
 * @param {string | null | undefined} header
 * @param {string[]} produces
 * @returns {string | null}
 */
export function preferredType(header, produces) {
  if (produces.length === 0) return null;
  if (!header) return produces[0] ?? null;

  const entries = parseAccept(header);
  if (entries.length === 0) return produces[0] ?? null;

  /** @type {string | null} */
  let bestType = null;
  let bestQ = -1;
  let bestPos = Infinity;

  for (const candidate of produces) {
    /** @type {AcceptEntry | null} */
    let matched = null;
    let matchedPos = Infinity;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!matches(entry, candidate)) continue;
      if (
        matched === null ||
        entry.specificity > matched.specificity ||
        (entry.specificity === matched.specificity && i < matchedPos)
      ) {
        matched = entry;
        matchedPos = i;
      }
    }
    if (!matched || matched.q <= 0) continue;
    if (matched.q > bestQ || (matched.q === bestQ && matchedPos < bestPos)) {
      bestQ = matched.q;
      bestPos = matchedPos;
      bestType = candidate;
    }
  }

  return bestType;
}

/**
 * True when the client prefers text/markdown over text/html.
 *
 * @param {string | null | undefined} header
 */
export function prefersMarkdown(header) {
  return preferredType(header, ["text/html", "text/markdown"]) === "text/markdown";
}

/**
 * File-index paths to try for a markdown sibling of `pathname`.
 * `/` → `/index.md`; `/about` → `/about.md` then `/about/index.md`.
 *
 * @param {string} pathname
 * @returns {string[]}
 */
export function markdownSiblingPaths(pathname) {
  if (pathname.endsWith(".md")) return [pathname];
  const uri =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (uri === "" || uri === "/") return ["/index.md"];
  return [`${uri}.md`, `${uri}/index.md`];
}

/**
 * Public URL of the explicit `.md` mirror for Link: rel=alternate.
 *
 * @param {string} pathname
 */
export function markdownPublicPath(pathname) {
  return markdownSiblingPaths(pathname)[0] ?? `${pathname}.md`;
}

/**
 * Append a Vary token without duplicating a case-insensitive match.
 *
 * @param {Headers} headers
 * @param {string} token
 */
export function appendVary(headers, token) {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", token);
    return;
  }
  const tokens = existing.split(",").map((part) => part.trim().toLowerCase());
  if (!tokens.includes(token.toLowerCase())) {
    headers.set("vary", `${existing}, ${token}`);
  }
}

/** Ora / acceptmarkdown.com pair for any response that can be HTML or markdown. */
export const MARKDOWN_VARY = "Accept, Accept-Encoding";

/**
 * Set Vary: Accept, Accept-Encoding (that order). Extra tokens are kept after.
 *
 * @param {Headers} headers
 */
export function setMarkdownVary(headers) {
  const existing = headers.get("vary");
  const required = ["Accept", "Accept-Encoding"];
  if (!existing) {
    headers.set("vary", MARKDOWN_VARY);
    return;
  }
  const extras = existing
    .split(",")
    .map((part) => part.trim())
    .filter(
      (token) =>
        token.length > 0 &&
        !required.some((item) => item.toLowerCase() === token.toLowerCase()),
    );
  headers.set("vary", extras.length > 0 ? `${MARKDOWN_VARY}, ${extras.join(", ")}` : MARKDOWN_VARY);
}
