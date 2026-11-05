import { readFile } from "node:fs/promises";

// A release keeps its version across restarts. Build timestamps order new releases.
process.env.RIVET_NODE_VERSION ||= (
  await readFile(new URL("../.release-version", import.meta.url), "utf8")
).trim();

const endpoint = process.env.RIVET_ENDPOINT;
const token = process.env.RIVET_TOKEN;
if (!endpoint || !token) throw new Error("Set RIVET_ENDPOINT and RIVET_TOKEN.");
const namespace = process.env.RIVET_NAMESPACE || "default";
const pool = process.env.RIVET_POOL || "default";
const url = new URL(`/pools/${encodeURIComponent(pool)}`, endpoint);
url.searchParams.set("namespace", namespace);
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

// Storage is not necessarily ready when the Engine's /health first answers.
// Existing pool configuration is preserved on every subsequent deployment.
for (let attempt = 0; ; attempt++) {
  try {
    let response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      response = await fetch(url, {
        method: "PUT",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
    }
    if (!response.ok)
      throw new Error(`Rivet pool bootstrap returned HTTP ${response.status}.`);
    break;
  } catch (error) {
    if (attempt >= 59)
      throw new Error("Rivet pool bootstrap did not become ready.", {
        cause: error,
      });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

await import("../apps/api/src/index.ts");
