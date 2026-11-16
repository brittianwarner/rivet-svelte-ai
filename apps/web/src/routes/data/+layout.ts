import { error } from "@sveltejs/kit";
import type { ClientConfig } from "@example/wire";
import type { LayoutLoad } from "./$types";

// Actor sockets live in the browser. The server sends the shell; data streams in.
export const ssr = false;

export const load: LayoutLoad = async ({ fetch }) => {
  const response = await fetch("/api/client-config").catch(() => null);
  if (!response?.ok)
    error(
      503,
      "The API is not reachable. Start it with bun run dev, then reload.",
    );
  const config = (await response.json()) as ClientConfig;
  return { config };
};
