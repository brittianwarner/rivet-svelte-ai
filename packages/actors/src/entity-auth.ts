import { log } from "@example/config";
import { configureEntities } from "@example/entities";
import { createFileStore, fileStoreConfig } from "@example/files";
import { authorizeConnection } from "./auth.ts";

/**
 * Every replica must verify every other replica's tokens, so production
 * needs one shared ENTITY_SECRET. Locally a random secret is fine.
 *
 * Files (exports) go to the api's bucket (FILES_*), or `.rivet/files` in
 * development. Production without a bucket is a boot error.
 */
export function configureEntityAuth(): void {
  const secret = process.env.ENTITY_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error(
      "Set ENTITY_SECRET: replicas must share it to verify each other's tokens.",
    );
  }
  const files = fileStoreConfig();
  log.info("file store", {
    kind: files.kind,
    ...(files.kind === "s3"
      ? { bucket: files.settings.bucket, prefix: files.settings.prefix }
      : { dir: files.root }),
  });
  configureEntities({
    ...(secret ? { secret } : {}),
    files: createFileStore(files),
    // Same transport rule as the other actors: allowed origin, demo token.
    authorizeTransport: (c, params) => authorizeConnection(c, params),
  });
}
