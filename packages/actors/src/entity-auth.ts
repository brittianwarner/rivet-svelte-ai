import { configureEntities } from "@example/entities";
import { authorizeConnection } from "./auth.ts";

/**
 * Every replica must verify every other replica's tokens, so production
 * needs one shared ENTITY_SECRET. Locally a random secret is fine.
 */
export function configureEntityAuth(): void {
  const secret = process.env.ENTITY_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "Set ENTITY_SECRET: replicas must share it to verify each other's tokens.",
    );
  }
  configureEntities({
    ...(secret ? { secret } : {}),
    // Same transport rule as the other actors: allowed origin, demo token.
    authorizeTransport: (c, params) => authorizeConnection(c, params),
  });
}
