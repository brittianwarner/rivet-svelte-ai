import {
  bucket,
  defineRailway,
  github,
  project,
  ref,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  // Forks: change repository to your fork before the first plan.
  const repository = "brittianwarner/rivet-svelte-ai";
  // Preserve the bucket already created in this project.
  const objects = bucket("adaptable-stashbox", { region: "sjc" });
  const log = volume("rivet-log", { region: "us-west2", sizeMB: 5120 });
  const rivet = service("rivet", {
    source: github(repository, { branch: "main", checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/rivet.Dockerfile" },
    replicas: 1,
    healthcheck: "/health",
    healthcheckTimeout: 180,
    volumeMounts: { "/var/lib/rivet/log": log },
    deploy: {
      region: "us-west2",
      restartPolicyType: "ON_FAILURE",
      drainingSeconds: 60,
    },
    env: {
      PORT: "6420",
      RIVET__GUARD__HOST: "::",
      RIVET__AUTH__ADMIN_TOKEN: { generator: "secret(64)" },
      RIVET__STORAGE__LOG_DIRECTORY: "/var/lib/rivet/log",
      RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
      RIVET__STORAGE__BALANCING__ENABLED: "false",
      // Leave room for the Engine's mandatory 4 GiB free-space reserve.
      RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: "536870912",
      RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "134217728",
      RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET: ref(objects, "BUCKET"),
      RIVET__OBJECT_STORAGE__PRIMARY__S3__REGION: ref(objects, "REGION"),
      RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT: ref(objects, "ENDPOINT"),
      RIVET__OBJECT_STORAGE__PRIMARY__S3__ACCESS_KEY_ID: ref(
        objects,
        "ACCESS_KEY_ID",
      ),
      RIVET__OBJECT_STORAGE__PRIMARY__S3__SECRET_ACCESS_KEY: ref(
        objects,
        "SECRET_ACCESS_KEY",
      ),
      RIVET__OBJECT_STORAGE__PRIMARY__S3__PREFIX: "rivet",
      AWS_VIRTUAL_HOSTED_STYLE_REQUEST: "true",
      RIVET__TELEMETRY__ENABLED: "false",
    },
  });
  const api = service("api", {
    source: github(repository, { branch: "main", checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/api.Dockerfile" },
    replicas: 1,
    healthcheck: "/health/actors",
    healthcheckTimeout: 240,
    deploy: {
      region: "us-west2",
      restartPolicyType: "ON_FAILURE",
      drainingSeconds: 60,
    },
    env: {
      PORT: "3001",
      API_HOST: "::",
      NODE_ENV: "production",
      RIVET_ENDPOINT: "http://${{rivet.RAILWAY_PRIVATE_DOMAIN}}:6420",
      RIVET_PUBLIC_ENDPOINT: "https://${{rivet.RAILWAY_PUBLIC_DOMAIN}}",
      RIVET_TOKEN: rivet.env.RIVET__AUTH__ADMIN_TOKEN,
      RIVET_NAMESPACE: "default",
      WEB_ORIGINS: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
      RIVET_INSPECTOR_DISABLE: "1",
    },
  });
  const web = service("web", {
    source: github(repository, { branch: "main", checkSuites: true }),
    build: { builder: "DOCKERFILE", dockerfilePath: "deploy/web.Dockerfile" },
    replicas: 1,
    healthcheck: "/api/health/actors",
    healthcheckTimeout: 240,
    deploy: { region: "us-west2", restartPolicyType: "ON_FAILURE" },
    env: {
      PORT: "3000",
      HOST: "::",
      NODE_ENV: "production",
      API_ORIGIN: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3001",
      WEB_ORIGIN: "https://${{web.RAILWAY_PUBLIC_DOMAIN}}",
    },
  });
  return project("rivet-svelte-ai", {
    resources: [objects, log, rivet, api, web],
  });
});
