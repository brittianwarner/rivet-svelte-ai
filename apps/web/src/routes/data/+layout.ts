import { error } from "@sveltejs/kit";
import type { ClientConfig } from "@example/wire";
import { preloadPrincipal } from "#lib/data/principal.svelte.js";
import type { LayoutLoad } from "./$types";

// Actor sockets live in the browser. The server sends the shell; data streams in.
export const ssr = false;

export const load: LayoutLoad = async ({ fetch }) => {
  // Personas and the remembered sign-in start now, beside the config,
  // instead of one after another once the page mounts.
  const principal = preloadPrincipal(fetch);
  const response = await fetch("/api/client-config").catch(() => null);
  if (!response?.ok)
    error(
      503,
      "The API is not reachable. Start it with bun run dev, then reload.",
    );
  const config = (await response.json()) as ClientConfig;
  return { config, principal };
};
