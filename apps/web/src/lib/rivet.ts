import type { AppRegistry } from "@example/actors";
import { createRivetContext, type createClient } from "@rivetkit/svelte";
import { createContext } from "svelte";

/** Context definitions are shared; clients and credentials belong to each provider. */
export const rivetContext = createRivetContext<AppRegistry>("AppRivet");
export const [getActorToken, setActorToken] = createContext<string | null>();
export const getRivet = rivetContext.get;
/**
 * The plain client, for one-shot calls that need no socket, such as an
 * actor's `fetch` for a file download.
 */
export type RivetClient = ReturnType<typeof createClient<AppRegistry>>;
export const [getRivetClient, setRivetClient] = createContext<RivetClient>();
