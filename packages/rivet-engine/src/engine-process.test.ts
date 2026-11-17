import { describe, expect, test } from "bun:test";
import {
  engineEnv,
  peerAddress,
  privateIpv6,
  s3Endpoint,
  s3FromEnv,
} from "./engine-process.ts";
import type { NetworkInterfaceInfo } from "node:os";

const S3 = {
  S3_BUCKET: "stash-1a2b",
  S3_ENDPOINT: "https://storage.example.com",
  S3_ACCESS_KEY_ID: "key-id",
  S3_SECRET_ACCESS_KEY: "secret",
};

describe("privateIpv6", () => {
  test("picks the first unique-local address and formats it", () => {
    const table = [
      "00000000000000000000000000000001 01 80 10 80       lo",
      "fe800000000000000000000000000001 02 40 20 80     eth0",
      "fd12345600000000abcd000000000042 02 40 00 80     eth0",
    ].join("\n");
    expect(privateIpv6(table)).toBe("fd12:3456:0000:0000:abcd:0000:0000:0042");
  });

  test("returns null without one", () => {
    expect(
      privateIpv6("fe800000000000000000000000000001 02 40 20 80 eth0"),
    ).toBeNull();
  });
});

describe("peerAddress", () => {
  const info = (
    address: string,
    family: "IPv4" | "IPv6",
    internal = false,
  ): NetworkInterfaceInfo =>
    ({
      address,
      family,
      internal,
      netmask: "",
      mac: "00:00:00:00:00:00",
      cidr: `${address}/${family === "IPv6" ? 64 : 24}`,
      ...(family === "IPv6" ? { scopeid: 0 } : {}),
    }) as NetworkInterfaceInfo;
  const none = { ifInet6: null, privateNames: [] };

  test("prefers a unique-local IPv6 on an interface", () => {
    const interfaces = {
      lo: [info("127.0.0.1", "IPv4", true), info("::1", "IPv6", true)],
      eth0: [
        info("10.1.2.3", "IPv4"),
        info("fe80::1", "IPv6"),
        info("FD12:3456::42", "IPv6"),
      ],
    };
    expect(peerAddress({ interfaces, ...none })).toBe("[fd12:3456::42]:6421");
  });

  test("falls back to /proc/net/if_inet6", () => {
    expect(
      peerAddress({
        interfaces: { eth0: [info("fe80::1", "IPv6")] },
        ifInet6: "fd12345600000000abcd000000000042 02 40 00 80 eth0",
        privateNames: [],
      }),
    ).toBe("[fd12:3456:0000:0000:abcd:0000:0000:0042]:6421");
  });

  test("uses a private IPv4 only when the private name resolves to it", () => {
    const interfaces = {
      eth0: [info("10.0.0.5", "IPv4")],
      eth1: [info("10.250.0.9", "IPv4")],
    };
    expect(peerAddress({ interfaces, ...none })).toBeNull();
    expect(
      peerAddress({
        interfaces,
        ifInet6: null,
        privateNames: ["10.250.0.7", "10.250.0.9"],
      }),
    ).toBe("10.250.0.9:6421");
  });

  test("ignores loopback and public addresses", () => {
    const interfaces = {
      lo: [info("fd00::1", "IPv6", true)],
      eth0: [info("203.0.113.7", "IPv4"), info("2001:db8::7", "IPv6")],
    };
    expect(
      peerAddress({ interfaces, ifInet6: null, privateNames: ["203.0.113.7"] }),
    ).toBeNull();
  });
});

describe("s3 settings", () => {
  test("names every missing variable", () => {
    expect(s3FromEnv({ S3_BUCKET: "b" })).toEqual({
      missing: ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
    });
  });

  test("virtual-hosted endpoints carry the bucket host exactly once", () => {
    const base = {
      bucket: "stash",
      endpoint: "https://storage.example.com",
      virtualHosted: true,
    };
    expect(s3Endpoint(base)).toBe("https://stash.storage.example.com");
    expect(
      s3Endpoint({ ...base, endpoint: "https://stash.storage.example.com" }),
    ).toBe("https://stash.storage.example.com");
    expect(s3Endpoint({ ...base, virtualHosted: false })).toBe(
      "https://storage.example.com",
    );
    expect(() =>
      s3Endpoint({ ...base, endpoint: "http://storage.example.com" }),
    ).toThrow("https");
    // Path-style too: the engine's client sends nothing over plain http.
    expect(() =>
      s3Endpoint({
        ...base,
        virtualHosted: false,
        endpoint: "http://minio:9000",
      }),
    ).toThrow("https");
  });
});

describe("engineEnv", () => {
  const settings = (
    s3FromEnv(S3) as { settings: Parameters<typeof engineEnv>[0]["s3"] }
  ).settings;
  const env = (base: Record<string, string> = {}) =>
    engineEnv({
      adminToken: "admin",
      s3: settings,
      advertise: "[fd12::42]:6421",
      guardHost: "127.0.0.1",
      base: { ...S3, RIVET_TOKEN: "admin", PATH: "/usr/bin", ...base },
    });

  test("configures a clustered, S3-backed node", () => {
    const result = env();
    expect(result.RIVET__STORAGE__BALANCING__ENABLED).toBe("true");
    expect(result.RIVET__STORAGE__AUTO_PROVISION_PARTITIONS).toBeUndefined();
    expect(result.RIVET__API_PEER__ADVERTISE_ADDRESS).toBe("[fd12::42]:6421");
    expect(result.RIVET__GUARD__HOST).toBe("127.0.0.1");
    expect(result.RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT).toBe(
      "https://stash-1a2b.storage.example.com",
    );
    expect(result.RIVET__AUTH__ADMIN_TOKEN).toBe("admin");
  });

  test("operator RIVET__* values win over defaults", () => {
    expect(
      env({ RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS: "5000" })
        .RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS,
    ).toBe("5000");
  });

  test("app secrets do not reach the engine process", () => {
    const result = env({ OPENROUTER_API_KEY: "sk", ENTITY_SECRET: "x" });
    expect(result.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.RIVET_TOKEN).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin");
  });
});
