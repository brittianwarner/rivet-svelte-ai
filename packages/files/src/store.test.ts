import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFileKey,
  bucketEndpoint,
  diskFileStore,
  fileStoreConfig,
  memoryFileStore,
  s3FileStore,
  type FileStore,
} from "./store.ts";

const root = await mkdtemp(join(tmpdir(), "files-test-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const stores: [string, () => FileStore][] = [
  ["memory", () => memoryFileStore()],
  ["disk", () => diskFileStore(root)],
];

// Against a real bucket when one is configured (MinIO locally, see docs).
const s3 = process.env.FILES_TEST_ENDPOINT
  ? fileStoreConfig({
      FILES_BUCKET: process.env.FILES_TEST_BUCKET ?? "files",
      FILES_ENDPOINT: process.env.FILES_TEST_ENDPOINT,
      FILES_REGION: "us-east-1",
      FILES_ACCESS_KEY_ID: process.env.FILES_TEST_ACCESS_KEY_ID,
      FILES_SECRET_ACCESS_KEY: process.env.FILES_TEST_SECRET_ACCESS_KEY,
      FILES_PREFIX: `test-${crypto.randomUUID().slice(0, 8)}`,
      FILES_VIRTUAL_HOSTED: process.env.FILES_TEST_VIRTUAL_HOSTED ?? "false",
    })
  : null;
if (s3?.kind === "s3") stores.push(["s3", () => s3FileStore(s3.settings)]);

for (const [name, make] of stores) {
  describe(name, () => {
    const store = make();

    test("round-trips bytes and content type", async () => {
      await store.put("exports/org-1/a.csv", "a,b\r\n1,2\r\n", {
        contentType: "text/csv; charset=utf-8",
      });
      const file = await store.get("exports/org-1/a.csv");
      expect(file).not.toBeNull();
      expect(file!.size).toBe(10);
      expect(file!.contentType).toBe("text/csv; charset=utf-8");
      expect(await new Response(file!.body).text()).toBe("a,b\r\n1,2\r\n");
    });

    test("overwrites", async () => {
      await store.put("k.bin", new Uint8Array([1]), { contentType: "a/b" });
      await store.put("k.bin", new Uint8Array([2, 3]), { contentType: "a/b" });
      const file = await store.get("k.bin");
      expect(
        new Uint8Array(await new Response(file!.body).arrayBuffer()),
      ).toEqual(new Uint8Array([2, 3]));
    });

    test("a missing key is null, and delete is idempotent", async () => {
      expect(await store.get("nope/never.csv")).toBeNull();
      await store.put("gone.txt", "x", { contentType: "text/plain" });
      await store.delete("gone.txt");
      await store.delete("gone.txt");
      expect(await store.get("gone.txt")).toBeNull();
    });

    test("refuses keys that could escape the root", async () => {
      for (const key of ["../x", "/abs", "a//b", "a/../b", "sp ace", ""]) {
        await expect(
          store.put(key, "x", { contentType: "text/plain" }),
        ).rejects.toThrow("Invalid file key");
      }
    });
  });
}

describe("config", () => {
  test("a bucket needs its credentials", () => {
    expect(() => fileStoreConfig({ FILES_BUCKET: "b" })).toThrow(
      "FILES_ENDPOINT, FILES_ACCESS_KEY_ID, FILES_SECRET_ACCESS_KEY",
    );
  });

  test("a bucket config normalizes the prefix and endpoint", () => {
    const config = fileStoreConfig({
      FILES_BUCKET: "b",
      FILES_ENDPOINT: "https://storage.example.com/",
      FILES_ACCESS_KEY_ID: "id",
      FILES_SECRET_ACCESS_KEY: "secret",
      FILES_PREFIX: "files",
    });
    expect(config).toMatchObject({
      kind: "s3",
      settings: {
        endpoint: "https://storage.example.com",
        prefix: "files/",
        region: "auto",
        virtualHostedStyle: true,
      },
    });
  });

  test("development falls back to a directory; production refuses", () => {
    expect(fileStoreConfig({}).kind).toBe("disk");
    expect(fileStoreConfig({ FILES_DIR: "/tmp/f" })).toEqual({
      kind: "disk",
      root: "/tmp/f",
    });
    expect(() => fileStoreConfig({ NODE_ENV: "production" })).toThrow(
      "FILES_BUCKET",
    );
  });

  test("virtual-hosted endpoints carry the bucket host", () => {
    const base = { bucket: "files", endpoint: "https://storage.example.com" };
    expect(bucketEndpoint({ ...base, virtualHostedStyle: true })).toBe(
      "https://files.storage.example.com",
    );
    expect(
      bucketEndpoint({
        ...base,
        endpoint: "https://files.storage.example.com",
        virtualHostedStyle: true,
      }),
    ).toBe("https://files.storage.example.com");
    expect(bucketEndpoint({ ...base, virtualHostedStyle: false })).toBe(
      "https://storage.example.com",
    );
  });

  test("keys", () => {
    expect(assertFileKey("exports/o/p/e.csv")).toBe("exports/o/p/e.csv");
    expect(() => assertFileKey("x/..")).toThrow();
  });
});
