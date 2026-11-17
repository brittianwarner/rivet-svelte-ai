import { setup, type Registry } from "rivetkit";
import { entityActors } from "@example/entities";
import { counter } from "./counter.ts";
import { chat } from "./chat.ts";
import { session } from "./session.ts";

/**
 * Every actor this app can host. Add yours here; the browser picks up the
 * types through `import type { AppRegistry } from "@example/actors"`.
 *
 * The entity actors must keep the names `user`, `organization`, `project` and
 * `projectExport`: they call each other through `c.client()` by those names.
 */
export const actors = {
  counter,
  chat,
  session,
  ...entityActors,
};

/** The full set, chat included, so typed clients compile either way. */
export type AppRegistry = Registry<typeof actors>;

export interface RegistryOptions {
  /**
   * Engine Guard URL. In development this is the local engine
   * (`startLocalEngine`), never one RivetKit spawns: its launcher shares one
   * data directory across every project on the machine.
   */
  endpoint: string;
  /** Engine admin token for runner registration. */
  token?: string;
  namespace: string;
  pool: string;
  /** Increases every release so actors drain onto the new code. */
  version: number;
  /**
   * Cap on waiting for actors to stop at shutdown. Default: the engine's
   * actor stop threshold (production). Development passes a few seconds so a
   * reload is quick.
   */
  shutdownGraceMs?: number;
  /**
   * Host the chat actor. Every chat turn spends model budget, so pass true
   * only when a model provider is configured (`chooseProvider()`).
   */
  chat: boolean;
}

/**
 * Without chat a runner hosts everything else. A call to a chat key then
 * waits at the engine until it times out, so clients check `/api/ready` first.
 */
const { chat: _chat, ...withoutChat } = actors;

export function createRegistry(opts: RegistryOptions): AppRegistry {
  return setup({
    use: opts.chat ? actors : withoutChat,
    namespace: opts.namespace,
    node: { poolName: opts.pool, version: opts.version },
    // The server owns SIGTERM so it can drain actors before stopping the engine.
    shutdown: {
      disableSignalHandlers: true,
      ...(opts.shutdownGraceMs ? { gracePeriodMs: opts.shutdownGraceMs } : {}),
    },
    noWelcome: true,
    endpoint: opts.endpoint,
    ...(opts.token ? { token: opts.token } : {}),
  }) as AppRegistry;
}
