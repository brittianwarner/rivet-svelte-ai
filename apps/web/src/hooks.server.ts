import type { Handle } from "@sveltejs/kit";

const API_ORIGIN = "http://127.0.0.1:3001";

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

  const target = new URL(`${pathname.slice("/api".length)}${search}`, API_ORIGIN);
  const method = event.request.method;
  const headers = withoutHopHeaders(event.request.headers);
  const hasBody = method !== "GET" && method !== "HEAD";

  const response = await fetch(target, {
    method,
    headers,
    body: hasBody ? await event.request.arrayBuffer() : undefined,
  });

  const responseHeaders = withoutHopHeaders(response.headers);
  responseHeaders.delete("content-encoding");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};
