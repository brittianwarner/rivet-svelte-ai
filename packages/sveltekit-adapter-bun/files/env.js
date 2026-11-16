/* global ENV_PREFIX */

const expected = new Set([
  "SOCKET_PATH",
  "HOST",
  "PORT",
  "ORIGIN",
  "XFF_DEPTH",
  "ADDRESS_HEADER",
  "PROTOCOL_HEADER",
  "HOST_HEADER",
  "PORT_HEADER",
  "BODY_SIZE_LIMIT",
  "SHUTDOWN_TIMEOUT",
  "IDLE_TIMEOUT",
  "NO_IDLE_TIMEOUT_PATHS",
  "KEEP_ALIVE_TIMEOUT",
  "HEADERS_TIMEOUT",
]);

/**
 * adapter-node Node-http timeouts. Allowed under an envPrefix so a migrated
 * deployment does not fail startup, but Bun.serve has no equivalent, so they
 * are ignored with a warning.
 */
const ignored = ["KEEP_ALIVE_TIMEOUT", "HEADERS_TIMEOUT"];

/**
 * Validate the prefixed environment. Throws on an unexpected prefixed name
 * (adapter-node parity) and returns the adapter-node names that are set but
 * ignored under Bun. Pure: reads only its arguments.
 *
 * @param {{ prefix: string, source: Record<string, string | undefined> }} options
 * @returns {{ ignored: string[] }} fully prefixed names
 */
function checkEnv({ prefix, source }) {
  if (prefix) {
    for (const name in source) {
      if (name.startsWith(prefix)) {
        const unprefixed = name.slice(prefix.length);
        if (!expected.has(unprefixed)) {
          throw new Error(
            `You should change envPrefix (${prefix}) to avoid conflicts with existing environment variables — unexpectedly saw ${name}`,
          );
        }
      }
    }
  }

  return {
    ignored: ignored
      .map((name) => prefix + name)
      .filter((name) => name in source),
  };
}

/**
 * @param {string[]} names fully prefixed names from checkEnv
 * @returns {string}
 */
function ignoredEnvWarning(names) {
  return `Ignoring ${names.join(", ")}: Bun.serve has no keep-alive or headers timeout. Use IDLE_TIMEOUT (0-255 seconds) to bound idle connections.`;
}

const envCheck = checkEnv({ prefix: ENV_PREFIX, source: Bun.env });
if (envCheck.ignored.length > 0) {
  console.warn(ignoredEnvWarning(envCheck.ignored));
}

/**
 * @param {string} name
 * @param {unknown} fallback
 */
function env(name, fallback) {
  const prefixed = ENV_PREFIX + name;
  return prefixed in Bun.env ? Bun.env[prefixed] : fallback;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {string} description
 * @returns {never}
 */
function parsingError(name, value, description) {
  throw new Error(
    `Invalid value for environment variable ${ENV_PREFIX + name}: ${JSON.stringify(value)} (${description})`,
  );
}

/** @type {Record<string, number | undefined>} */
const byteUnits = {
  B: 1,
  K: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
};

/**
 * Parse Bun/adapter-node style byte strings: 512K, 1.5M, 1G, 10B, raw bytes,
 * or `Infinity` (no limit; Bun.serve accepts it as `maxRequestBodySize`, and
 * SvelteKit recommends it over 0). Fractional results are floored.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function parseBytes(value, name) {
  const text = String(value ?? "").trim();
  if (text === "Infinity") return Infinity;

  const multiplier = byteUnits[text.at(-1)?.toUpperCase() ?? ""];
  const numberText = (
    multiplier === undefined ? text : text.slice(0, -1)
  ).trim();
  const parsed = Number(numberText) * (multiplier ?? 1);

  if (!numberText || !Number.isFinite(parsed) || parsed < 0) {
    parsingError(
      name,
      value,
      "should be a non-negative byte count such as 512K, 10M, 1200000000, or Infinity",
    );
  }

  return Math.floor(parsed);
}

/**
 * Parse a non-negative integer with an optional upper bound. The error names
 * the prefixed environment variable.
 *
 * @param {{ name: string, value: unknown, max?: number }} options
 * @returns {number}
 */
function parseNonNegativeInteger({ name, value, max }) {
  const parsed = Number.parseInt(String(value), 10);

  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    String(value).trim() !== String(parsed)
  ) {
    parsingError(name, value, "should be a non-negative integer");
  }

  if (max !== undefined && parsed > max) {
    parsingError(name, value, `should be an integer from 0 to ${max}`);
  }

  return parsed;
}

/**
 * @param {string} name
 * @param {number} fallback
 * @param {{ max?: number }} [options]
 * @returns {number}
 */
function nonNegativeIntegerEnv(name, fallback, { max } = {}) {
  return parseNonNegativeInteger({
    name,
    value: env(name, String(fallback)),
    max,
  });
}

export {
  checkEnv,
  env,
  ignoredEnvWarning,
  nonNegativeIntegerEnv,
  parseBytes,
  parseNonNegativeInteger,
};
