import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { BunAdapterPlatform } from "../ambient.js";

const packageRoot = join(import.meta.dir, "..");
/** Published declaration surface; other files are covered by `bun run check`. */
const declarationFiles = [
  "ambient.d.ts",
  "index.d.ts",
  "runtime-shims.d.ts",
  "index.js",
];

type IsAny<T> = 0 extends 1 & T ? true : false;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Compile-time guards, enforced by `bun run check` (tsconfig includes tests).
const serverIsNotAny: IsAny<App.Platform["bun"]["server"]> = false;
const serverIsTyped: Equals<
  App.Platform["bun"]["server"],
  Server<undefined> | undefined
> = true;
const requestIsOptional: Equals<
  BunAdapterPlatform["request"],
  Request | undefined
> = true;
// `emulate()` provides only setRequestTimeout, so it must satisfy App.Platform.
const emulated: App.Platform = { bun: { setRequestTimeout() {} } };

describe("type declarations", () => {
  test("compile-time guards are wired", () => {
    expect([serverIsNotAny, serverIsTyped, requestIsOptional]).toEqual([
      false,
      true,
      true,
    ]);
    expect(typeof emulated.bun.setRequestTimeout).toBe("function");
  });

  test("package declarations type-check with skipLibCheck disabled", () => {
    // skipLibCheck hides errors in our own .d.ts files (e.g. TS2314 on a bare
    // generic `Server`). Check with it off and ignore third-party lib errors.
    const tsc = join(
      dirname(require.resolve("typescript/package.json")),
      "bin/tsc",
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        tsc,
        "--noEmit",
        "--skipLibCheck",
        "false",
        "-p",
        "tsconfig.json",
      ],
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );
    const ownErrors = `${result.stdout.toString()}${result.stderr.toString()}`
      .split("\n")
      .filter((line) => /error TS\d+/.test(line))
      .filter((line) =>
        declarationFiles.some((file) => line.startsWith(`${file}(`)),
      );

    expect(ownErrors).toEqual([]);
  }, 60_000);
});

describe("build-time tokens", () => {
  const read = (file: string): string =>
    readFileSync(join(packageRoot, file), "utf8");
  const replaceBlock = /const tokens = \{([\s\S]*?)\n\s*\};/.exec(
    read("index.js"),
  );
  const tokens = [
    ...(replaceBlock?.[1] ?? "").matchAll(/^\s*([A-Z_]+):/gm),
  ].map((match) => match[1] ?? "");
  const runtimeSources = readdirSync(join(packageRoot, "files"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => read(join("files", name)));

  test("every replaced token is used by a runtime file", () => {
    expect(tokens.length).toBeGreaterThan(0);
    const unused = tokens.filter(
      (token) =>
        !runtimeSources.some((source) =>
          new RegExp(`\\b${token}\\b`).test(source),
        ),
    );
    expect(unused).toEqual([]);
  });

  test("the published index.d.ts declares no build-time globals", () => {
    const published = read("index.d.ts");
    expect(published).not.toContain("declare global");
    for (const token of tokens) {
      expect(published).not.toMatch(new RegExp(`\\b${token}\\b`));
    }
  });
});
