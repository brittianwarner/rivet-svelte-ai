/**
 * The split layout: engine, actor runner and front as separate processes on
 * one engine. Same image, different ROLE. Proves a service can be pulled out
 * of the single container without code changes.
 * Run with `bun run test:integration`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { organizationKey, type OrganizationSnapshot } from "@example/entities";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    enginePort: 6600,
    port: 3050,
    roles: ["runner", "front"],
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
}, 60_000);

test("the runner answers health checks and nothing else", async () => {
  const runner = "http://127.0.0.1:3051";
  expect((await fetch(`${runner}/api/health/actors`)).status).toBe(200);
  expect((await fetch(`${runner}/api/client-config`)).status).toBe(404);
  expect((await fetch(`${runner}/rivet/metadata`)).status).toBe(404);
});

test("the front serves actors it does not host", async () => {
  const client = h.connect();
  try {
    const key = `tiers-${crypto.randomUUID()}`;
    const counter = client.counter.getOrCreate(["counter", key]);
    expect(await counter.increment(4)).toBe(4);
    const http = await fetch(`${h.origin}/api/counters/${key}/increment`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: JSON.stringify({ by: 1 }),
    });
    expect(await http.json()).toEqual({ count: 5 });
  } finally {
    await client.dispose();
  }
}, 60_000);

test("a token signed by the front is verified by the runner", async () => {
  const response = await fetch(`${h.origin}/api/entities/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: h.origin },
    body: JSON.stringify({ persona: "ada" }),
  });
  const { token } = (await response.json()) as { token: string };
  const client = h.connect();
  try {
    const org = client.organization.getOrCreate(
      organizationKey(`tiers-${crypto.randomUUID().slice(0, 8)}`),
      { params: { principal: token } },
    );
    const created = (await org.create({
      name: "Split Tiers",
    })) as OrganizationSnapshot;
    expect(created.ownerId).toBe("ada");
  } finally {
    await client.dispose();
  }
}, 60_000);
