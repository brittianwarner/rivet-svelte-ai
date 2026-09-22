import { browser } from "$app/environment";
import type { registry } from "@example/api/actors";
import type { ClientConfig } from "@example/wire";
import { createClient, createRivetContext, createSharedRivetKit } from "@rivetkit/svelte";

export const rivetContext = createRivetContext<typeof registry>("AppRivet");

let actorTokenValue: string | null = null;
let client: ReturnType<typeof createClient<typeof registry>> | null = null;

export function getActorToken(): string | null {
  return actorTokenValue;
}

export const getRivet = createSharedRivetKit<typeof registry>(() => {
  if (!client) {
    throw new Error("Rivet client is not ready");
  }
  return client;
});

async function loadRivet(): Promise<void> {
  const response = await fetch("/api/client-config");
  if (!response.ok) {
    throw new Error("Could not load client config");
  }

  const config = (await response.json()) as ClientConfig;
  actorTokenValue = config.actorToken;
  client = createClient<typeof registry>(config.rivetEndpoint);
}

/** Resolves once the shared actor client exists. SSR resolves immediately. */
export const rivetReady: Promise<void> = browser ? loadRivet() : Promise.resolve();
