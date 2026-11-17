import {
  bucket,
  defineRailway,
  github,
  project,
  ref,
  service,
} from "railway/iac";

/**
 * One image (the root Dockerfile), two buckets, nothing else.
 *
 * TOPOLOGY "split" (default) — three services, the production layout:
 *
 *   app     ROLE=web, public. Pages; forwards /api and /rivet to `api` over
 *           the private network. No secrets, no bucket. Scale on page load.
 *   api     ROLE=api, private. Actors, /api, the /rivet relay. Holds the
 *           engine credentials and principal-token secret, and keeps app
 *           files (exports) in its own bucket, `files`. Scale on actor load.
 *   engine  ROLE=engine, private, 3 replicas. The Rivet cluster: state in
 *           its own bucket, `rivet-cluster`. Redeploy it to upgrade Rivet.
 *
 * TOPOLOGY "all" — one service. Every replica runs an engine node, actors,
 * the API and the web app on port 8080. Simplest; one thread per replica
 * serves pages and actors.
 *
 * Engine nodes find each other through heartbeats in the bucket and
 * replicate over the private network (api_peer, 6421, plaintext — never give
 * it a public domain). Each write is held by two of three nodes' disks, then
 * tiers to the bucket. The two topologies use different prefixes, so a
 * switch starts a fresh cluster; the other prefix is left untouched.
 *
 * The public service is always named `app`, so its domain survives a switch.
 *
 * Plan only: `bun run railway:plan`. A human applies after reading every
 * Destroy line. Anything omitted from this file is deleted on apply.
 */
type Topology = "split" | "all";
const TOPOLOGY: Topology = "split";

export default defineRailway((ctx) => {
  // Forks: change repository to your fork before the first plan.
  const repository = "brittianwarner/rivet-svelte-ai";
  // Forks: your domain, or undefined to use a Railway domain.
  const domain =
    ctx.environment === "production" ? "svelteactors.dev" : undefined;
  // US East (Virginia). Keep the buckets in the same region: the engine
  // writes to its bucket continuously.
  const region = "us-east4-eqdc4a";
  /** Replicas are set per region; Railway ignores a bare count. */
  const replicas = (count: number) => ({ regions: { [region]: count } });
  const source = github(repository, { branch: "main", checkSuites: false });
  const build = {
    builder: "DOCKERFILE" as const,
    dockerfilePath: "Dockerfile",
  };

  // The engine's bucket. Two clusters must never share one prefix.
  const engineBucket = bucket("rivet-cluster", { region: "iad" });
  const engineS3 = {
    S3_BUCKET: ref(engineBucket, "BUCKET"),
    S3_ENDPOINT: ref(engineBucket, "ENDPOINT"),
    S3_REGION: ref(engineBucket, "REGION"),
    S3_ACCESS_KEY_ID: ref(engineBucket, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(engineBucket, "SECRET_ACCESS_KEY"),
    S3_PREFIX: TOPOLOGY === "split" ? "engine/" : "rivet-cluster/",
  };
  // The api's bucket: app files. The engine never reads it.
  const filesBucket = bucket("files", { region: "iad" });
  const files = {
    FILES_BUCKET: ref(filesBucket, "BUCKET"),
    FILES_ENDPOINT: ref(filesBucket, "ENDPOINT"),
    FILES_REGION: ref(filesBucket, "REGION"),
    FILES_ACCESS_KEY_ID: ref(filesBucket, "ACCESS_KEY_ID"),
    FILES_SECRET_ACCESS_KEY: ref(filesBucket, "SECRET_ACCESS_KEY"),
  };

  // Engine nodes: new replicas start, overlap, then the old ones drain. The
  // overlap lets new storage workers take replicas before the old ones
  // leave; the drain covers the partition handoff (590 s budget).
  const engineRollout = {
    restartPolicyType: "ON_FAILURE" as const,
    overlapSeconds: 120,
    drainingSeconds: 660,
  };
  // Stateless services: short overlap, drain long enough for actors to sleep.
  const statelessRollout = {
    restartPolicyType: "ON_FAILURE" as const,
    overlapSeconds: 30,
    drainingSeconds: 120,
  };

  const appName = "app";
  const origin = domain
    ? `https://${domain}`
    : `https://\${{${appName}.RAILWAY_PUBLIC_DOMAIN}}`;
  const listen = { NODE_ENV: "production", PORT: "8080", HOST: "::" };
  const actorsEnv = {
    ...listen,
    PUBLIC_ORIGIN: origin,
    RIVET_NAMESPACE: "starter",
    RIVET_INSPECTOR_DISABLE: "1",
    // Replicas verify each other's sign-in tokens, so they share one secret.
    ENTITY_SECRET: { generator: "secret(64)" },
    ...files,
  };
  const publicDomain = domain ? [{ domain, port: 8080 }] : [];

  if (TOPOLOGY === "all") {
    const app = service(appName, {
      source,
      build,
      ...replicas(3),
      domains: publicDomain,
      // Ready once this replica's runner is registered with the cluster.
      healthcheck: "/api/health/actors",
      // First boot of a fresh cluster provisions partitions; allow for it.
      healthcheckTimeout: 300,
      deploy: engineRollout,
      env: {
        ...actorsEnv,
        ...engineS3,
        // Read at build time too (Dockerfile ARG) for absolute SSR URLs.
        WEB_ORIGIN: origin,
        ROLE: "all",
        RIVET_TOKEN: { generator: "secret(64)" },
      },
    });
    return project("rivet-svelte-ai", {
      resources: [engineBucket, filesBucket, app],
    });
  }

  const engine = service("engine", {
    source,
    build,
    ...replicas(3),
    // Guard serves /health on 6420. It stays private: no domain.
    healthcheck: "/health",
    healthcheckTimeout: 300,
    deploy: engineRollout,
    env: {
      ...engineS3,
      ROLE: "engine",
      PORT: "6420",
      RIVET_TOKEN: { generator: "secret(64)" },
    },
  });

  const api = service("api", {
    source,
    build,
    ...replicas(2),
    // Private: reached only by `app` over the private network.
    healthcheck: "/api/health/actors",
    healthcheckTimeout: 240,
    deploy: statelessRollout,
    env: {
      ...actorsEnv,
      ROLE: "api",
      RIVET_ENDPOINT: "http://${{engine.RAILWAY_PRIVATE_DOMAIN}}:6420",
      RIVET_TOKEN: engine.env.RIVET_TOKEN,
    },
  });

  const app = service(appName, {
    source,
    build,
    ...replicas(2),
    domains: publicDomain,
    // This replica's own liveness; never waits on the api.
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    deploy: statelessRollout,
    env: {
      ...listen,
      ROLE: "web",
      // Read at build time too (Dockerfile ARG) for absolute SSR URLs.
      WEB_ORIGIN: origin,
      // Resolves to every api replica; web spreads requests across them.
      API_URL: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:8080",
    },
  });

  return project("rivet-svelte-ai", {
    resources: [engineBucket, filesBucket, engine, api, app],
  });
});
