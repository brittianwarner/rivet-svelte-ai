import { setup } from "rivetkit";
import { enginePort, loadRootEnv } from "./env.ts";
import { counter } from "./actors/counter.ts";
import { chat } from "./actors/chat.ts";
import { session } from "./actors/session.ts";

loadRootEnv();
export { counter, chat, session };

const cloudEndpoint = process.env.RIVET_ENDPOINT?.trim();
const localEnginePort = enginePort();

export const registry = setup({
  use: { counter, chat, session },
  ...(cloudEndpoint
    ? {}
    : {
        startEngine: true,
        // These examples use actors only; no agentOS/Services host is needed.
        startServices: false,
        enginePort: localEnginePort,
        httpPort: localEnginePort + 1,
      }),
});
