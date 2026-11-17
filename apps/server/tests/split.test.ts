/**
 * The production split: an engine, the api (ROLE=api) and web (ROLE=web) as
 * separate processes. Browsers reach only web; web forwards /api and /rivet
 * to the api, sockets included. Same image, different ROLE.
 * Run with `bun run test:integration`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  exportKey,
  organizationKey,
  projectKey,
  type OrganizationSnapshot,
  type ProjectSnapshot,
} from "@example/entities";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
// The harness gives the non-public role the port after the public one.
const api = "http://127.0.0.1:3051";

beforeAll(async () => {
  h = await startHarness({
    enginePort: 6600,
    port: 3050,
    roles: ["api", "web"],
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
}, 60_000);

async function signIn(persona: string): Promise<string> {
  const response = await fetch(`${h.origin}/api/entities/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: h.origin },
    body: JSON.stringify({ persona }),
  });
  return ((await response.json()) as { token: string }).token;
}

test("web answers its own health and forwards the rest", async () => {
  expect((await fetch(`${h.origin}/healthz`)).status).toBe(200);
  expect((await fetch(`${h.origin}/api/health/actors`)).status).toBe(200);
  // The client config names web, never the api, as the public origin.
  expect(h.config.rivetEndpoint.startsWith(h.origin)).toBe(true);
  expect((await fetch(`${api}/api/health/actors`)).status).toBe(200);
});

test("actor sockets and HTTP both reach the api through web", async () => {
  const client = h.connect();
  try {
    const key = `split-${crypto.randomUUID()}`;
    const counter = client.counter.getOrCreate(["counter", key]);
    expect(await counter.increment(4)).toBe(4);
    const connection = counter.connect();
    try {
      const seen = new Promise<number>((resolve) =>
        connection.on("newCount", (count: number) => resolve(count)),
      );
      const http = await fetch(`${h.origin}/api/counters/${key}/increment`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({ by: 1 }),
      });
      expect(await http.json()).toEqual({ count: 5 });
      expect(await seen).toBe(5);
    } finally {
      await connection.dispose();
    }
  } finally {
    await client.dispose();
  }
}, 60_000);

test("tokens, workflows and files work across the split", async () => {
  const token = await signIn("ada");
  const client = h.connect();
  try {
    const orgId = `split-${crypto.randomUUID().slice(0, 8)}`;
    const params = { principal: token };
    const org = client.organization.getOrCreate(organizationKey(orgId), {
      params,
    });
    const created = (await org.create({
      name: "Split",
    })) as OrganizationSnapshot;
    expect(created.ownerId).toBe("ada");
    await org.createProject({ projectId: "ledger", name: "Ledger" });
    const project = client.project.get(projectKey(orgId, "ledger"), { params });
    await project.addTask("Through web");
    const started = (await project.startExport()) as ProjectSnapshot;
    const exportId = started.exports[0]!.exportId;
    let snapshot = started;
    for (let i = 0; i < 100 && snapshot.exports[0]?.status !== "ready"; i++) {
      await Bun.sleep(100);
      snapshot = (await project.getSnapshot()) as ProjectSnapshot;
    }
    expect(snapshot.exports[0]?.status).toBe("ready");
    const file = await client.projectExport
      .get(exportKey(orgId, "ledger", exportId), { params })
      .fetch("/");
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("Through web");
  } finally {
    await client.dispose();
  }
}, 90_000);
