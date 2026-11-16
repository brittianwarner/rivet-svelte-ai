import {
  createConnectionHealth,
  type ConnectionHealth,
  type ConnectionSource,
} from "@rivetkit/svelte";
import { createContext, untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";

interface Live {
  readonly connStatus: string;
  readonly connectionError: Error | null;
}

/**
 * Every actor socket the browser has open right now, for the status line.
 * Pages add their view model while mounted; health is derived from all of them.
 */
export class ConnectionRegistry {
  readonly sources = new SvelteMap<string, ConnectionSource>();
  readonly health: ConnectionHealth = createConnectionHealth(() =>
    Object.fromEntries(this.sources),
  );

  /** Call from an `$effect`; returns the cleanup. */
  track(label: string, live: Live): () => void {
    const source: ConnectionSource = {
      get connStatus() {
        return live.connStatus;
      },
      get error() {
        return live.connectionError;
      },
    };
    untrack(() => this.sources.set(label, source));
    return () => {
      untrack(() => {
        if (this.sources.get(label) === source) this.sources.delete(label);
      });
    };
  }
}

export const [getConnections, setConnections] =
  createContext<ConnectionRegistry>();
