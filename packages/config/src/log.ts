/**
 * Structured logs: one JSON object per line, so Railway and any log drain can
 * filter on fields. Never pass tokens, keys, or message bodies as fields.
 */
type Fields = Record<string, unknown>;

function write(
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Fields,
): void {
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

export type Logger = typeof log;
