import type { Client } from "rivetkit/client";
import { systemParams } from "./principal.ts";
import type { EntityRegistry } from "./registry-types.ts";

/**
 * How entity actors call each other. Every call carries the server's own
 * principal, so the callee's `requireSystem` accepts it and nothing a browser
 * sends can.
 */
export interface PeerHost {
  client: () => Client<EntityRegistry>;
}

/** Fresh each call: the server's token is short-lived. */
export const asSystem = () => ({ params: systemParams() });

/**
 * Rivet's answer when `get` names an actor that was never created or was
 * destroyed. Use `get`, not `getOrCreate`, for anything a caller could name,
 * so a guessed key never creates an actor.
 */
export function isMissingActor(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, group } = error as { code?: unknown; group?: unknown };
  return code === "not_found" && (group === undefined || group === "actor");
}

/** Run a call to an actor that may be gone. Returns `fallback` if it is. */
export async function unlessMissing<T>(
  call: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isMissingActor(error)) return fallback;
    throw error;
  }
}
