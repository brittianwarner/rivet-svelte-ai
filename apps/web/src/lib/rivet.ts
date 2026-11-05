import type { registry } from "@example/api/actors";
import { createRivetContext } from "@rivetkit/svelte";
import { createContext } from "svelte";

/** Context definitions are shared; clients and credentials belong to each provider. */
export const rivetContext = createRivetContext<typeof registry>("AppRivet");
export const [getActorToken, setActorToken] = createContext<string | null>();
export const getRivet = rivetContext.get;
