import { describe, expect, test } from "bun:test";
import adapter from "../index.js";

describe("@example/sveltekit-adapter-bun", () => {
  test("exposes a SvelteKit adapter with read and instrumentation support", () => {
    const plugin = adapter();

    expect(plugin.name).toBe("@example/sveltekit-adapter-bun");
    expect(plugin.supports?.read?.({} as never)).toBe(true);
    expect(plugin.supports?.instrumentation?.()).toBe(true);
  });
});

describe("emulate", () => {
  test("provides platform.bun with a no-op setRequestTimeout", async () => {
    const emulator = await adapter().emulate?.();
    const platform = await emulator?.platform?.({
      config: {},
      prerender: false,
    });

    expect(platform).toBeDefined();
    expect(Object.keys(platform ?? {})).toEqual(["bun"]);
    expect(Object.keys(platform?.bun ?? {})).toEqual(["setRequestTimeout"]);
    expect(platform?.bun.setRequestTimeout(0)).toBeUndefined();
    expect(platform?.bun.server).toBeUndefined();
    expect(platform?.bun.request).toBeUndefined();
  });

  test("returns a fresh platform per call, including during prerender", async () => {
    const emulator = await adapter().emulate?.();
    const first = await emulator?.platform?.({ config: {}, prerender: true });
    const second = await emulator?.platform?.({ config: {}, prerender: false });

    expect(first).not.toBe(second);
    expect(typeof first?.bun.setRequestTimeout).toBe("function");
  });
});

describe("idleTimeout option", () => {
  test.each([0, 1, 255])("accepts %p", (idleTimeout) => {
    expect(() => adapter({ idleTimeout })).not.toThrow();
  });

  test.each([256, -1, 1.5, Number.NaN])("rejects %p", (idleTimeout) => {
    expect(() => adapter({ idleTimeout })).toThrow(
      /@example\/sveltekit-adapter-bun: idleTimeout must be an integer from 0 to 255/,
    );
  });
});
