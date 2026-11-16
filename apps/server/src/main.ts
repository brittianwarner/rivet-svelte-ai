import { log } from "@example/config";
import { main } from "./server.ts";

main().catch((error) => {
  log.error("boot failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
