import {
  bucket,
  defineRailway,
  github,
  project,
  ref,
  service,
} from "railway/iac";

/**
 * One image (the root Dockerfile), one bucket, nothing else.
 *
 * TOPOLOGY "all" — one service. Every replica runs an engine node, the actor
 * runner, the API and the web app on port 8080. Replicas find each other
 * through heartbeats in the bucket and replicate over the private network
 * (api_peer, 6421, plaintext — never give it a public domain). No volume: each
 * write is held by two of three nodes' disks, then tiers to the bucket.
 *
 * TOPOLOGY "split" — the same image as two services. `engine` (ROLE=engine,
 * 3 replicas) holds state and is redeployed only to upgrade Rivet. `app`
 * (ROLE=app) scales freely and redeploys on every push without rotating the
 * storage workers. Prefer it once deploys are frequent; docs/deployment.md
 * explains the trade.
 *
 * TOPOLOGY "tiers" — three services. `engine` as above, `runner`
 * (ROLE=runner) executes actors, `app` (ROLE=front) serves web, /api and
 * /rivet with no actors. Scale runners with actor load and the front with
 * request load, independently.
 *
 * The public service is always named `app`, so its domain survives a switch.
 *
 * Plan only: `bun run railway:plan`. A human applies after reading every
 * Destroy line. Anything omitted from this file is deleted on apply.
 */
type Topology = "all" | "split" | "tiers";
const TOPOLOGY: Topology = "all";

export default defineRailway((ctx) => {
  // Forks: change repository to your fork before the first plan.
  const repository = "brittianwarner/rivet-svelte-ai";
  // Forks: your domain, or undefined to use a Railway domain.
  const domain =
    ctx.environment === "production" ? "svelteactors.dev" : undefined;
  // US East (Virginia). Keep the bucket in the same region: the engine
  // writes to it continuously.
  const region = "us-east4-eqdc4a";
  /** Replicas are set per region; Railway ignores a bare count. */
  const replicas = (count: number) => ({ regions: { [region]: count } });
  const source = github(repository, { branch: "main", checkSuites: false });
  const build = {
    builder: "DOCKERFILE" as const,
    dockerfilePath: "Dockerfile",
  };

  // Engine state lives under its own prefix: two clusters must never share one.
  const objects = bucket("rivet-cluster", { region: "iad" });
  const s3 = {
    S3_BUCKET: ref(objects, "BUCKET"),
    S3_ENDPOINT: ref(objects, "ENDPOINT"),
    S3_REGION: ref(objects, "REGION"),
    S3_ACCESS_KEY_ID: ref(objects, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(objects, "SECRET_ACCESS_KEY"),
    S3_PREFIX: "rivet-cluster/",
  };

  // Deploys start the new replicas, overlap, then drain the old ones. The
  // overlap lets the new storage workers take replicas before the old ones
  // leave; the drain covers the engine's partition handoff (590 s budget).
  const rollout = {
    restartPolicyType: "ON_FAILURE" as const,
    overlapSeconds: 120,
    drainingSeconds: 660,
  };

  const appName = "app";
  const origin = domain
    ? `https://${domain}`
    : `https://\${{${appName}.RAILWAY_PUBLIC_DOMAIN}}`;
  const appEnv = {
    NODE_ENV: "production",
    PORT: "8080",
    HOST: "::",
    PUBLIC_ORIGIN: origin,
    // Read at build time too (Dockerfile ARG) for absolute SSR URLs.
    WEB_ORIGIN: origin,
    RIVET_NAMESPACE: "starter",
    RIVET_INSPECTOR_DISABLE: "1",
    // Replicas verify each other's sign-in tokens, so they share one secret.
    ENTITY_SECRET: { generator: "secret(64)" },
  };

  if (TOPOLOGY === "all") {
    const app = service(appName, {
      source,
      build,
      ...replicas(3),
      domains: domain ? [{ domain, port: 8080 }] : [],
      // Ready once this replica's runner is registered with the cluster.
      healthcheck: "/api/health/actors",
      // First boot of a fresh cluster provisions partitions; allow for it.
      healthcheckTimeout: 300,
      deploy: rollout,
      env: {
        ...appEnv,
        ...s3,
        ROLE: "all",
        RIVET_TOKEN: { generator: "secret(64)" },
      },
    });
    return project("rivet-svelte-ai", { resources: [objects, app] });
  }

  const engine = service("engine", {
    source,
    build,
    ...replicas(3),
    // Guard serves /health on 6420. It stays private: no domain.
    healthcheck: "/health",
    healthcheckTimeout: 300,
    deploy: rollout,
    env: {
      ...s3,
      ROLE: "engine",
      PORT: "6420",
      RIVET_TOKEN: { generator: "secret(64)" },
    },
  });
  const engineEnv = {
    RIVET_ENDPOINT: "http://${{engine.RAILWAY_PRIVATE_DOMAIN}}:6420",
    RIVET_TOKEN: engine.env.RIVET_TOKEN,
  };
  // Stateless tiers: short overlap, drain long enough for actors to sleep.
  const statelessRollout = {
    restartPolicyType: "ON_FAILURE" as const,
    overlapSeconds: 30,
    drainingSeconds: 120,
  };

  if (TOPOLOGY === "tiers") {
    const runner = service("runner", {
      source,
      build,
      ...replicas(2),
      // Private: answers only /api/health and /api/health/actors.
      healthcheck: "/api/health/actors",
      healthcheckTimeout: 240,
      deploy: statelessRollout,
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        HOST: "::",
        PUBLIC_ORIGIN: origin,
        RIVET_NAMESPACE: appEnv.RIVET_NAMESPACE,
        ROLE: "runner",
        ...engineEnv,
        ENTITY_SECRET: { generator: "secret(64)" },
      },
    });
    const front = service(appName, {
      source,
      build,
      ...replicas(2),
      domains: domain ? [{ domain, port: 8080 }] : [],
      // Ready once the engine answers; the front hosts no actors.
      healthcheck: "/api/health/actors",
      healthcheckTimeout: 240,
      deploy: statelessRollout,
      env: {
        ...appEnv,
        ROLE: "front",
        ...engineEnv,
        // Runners verify the tokens the front signs.
        ENTITY_SECRET: runner.env.ENTITY_SECRET,
      },
    });
    return project("rivet-svelte-ai", {
      resources: [objects, engine, runner, front],
    });
  }

  const app = service(appName, {
    source,
    build,
    ...replicas(2),
    domains: domain ? [{ domain, port: 8080 }] : [],
    healthcheck: "/api/health/actors",
    healthcheckTimeout: 240,
    deploy: statelessRollout,
    env: {
      ...appEnv,
      ROLE: "app",
      ...engineEnv,
    },
  });
  return project("rivet-svelte-ai", { resources: [objects, engine, app] });
});
