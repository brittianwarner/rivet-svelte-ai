import { API_ORIGIN } from "$app/env/private";
import type { Handle } from "@sveltejs/kit/hooks";

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
];

function withoutHopHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) next.delete(name.trim());
  }
  next.delete("host");
  next.delete("content-length");
  for (const name of HOP_BY_HOP) next.delete(name);
  return next;
}

/**
 * Forward product HTTP to the Hono process.
 * Actor sockets do not come through here. They use the endpoint from client-config.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/rivet")) {
    return resolve(event);
  }

  const target = new URL(API_ORIGIN);
  target.pathname = pathname.slice("/api".length);
  target.search = search;
  const method = event.request.method;
  const headers = withoutHopHeaders(event.request.headers);
  const hasBody = method !== "GET" && method !== "HEAD";

  let body: Uint8Array | undefined;
  if (hasBody && Number(event.request.headers.get("content-length")) > 1024) {
    return Response.json({ error: "Request body too large." }, { status: 413 });
  }
  if (hasBody && event.request.body) {
    const reader = event.request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) {
          return Response.json(
            { error: "Request body too large." },
            { status: 413 },
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      signal: AbortSignal.any([
        event.request.signal,
        AbortSignal.timeout(15_000),
      ]),
      redirect: "manual",
      body: body as BodyInit | undefined,
    });
  } catch {
    return Response.json(
      { error: "API unavailable. Start the API and try again." },
      { status: 502 },
    );
  }

  const responseHeaders = withoutHopHeaders(response.headers);
  responseHeaders.delete("content-encoding");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};
