import { UserError } from "rivetkit";
import { ENTITY_ERRORS, LIMITS } from "./contracts.ts";

/** Trim, collapse whitespace, and bound a display name or title. */
export function cleanName(value: unknown, label = "name"): string {
  return cleanText(value, { label, max: LIMITS.name, singleLine: true });
}

/** Trim and bound free text. Keeps line breaks unless `singleLine`. */
export function cleanText(
  value: unknown,
  opts: { label: string; max: number; singleLine?: boolean },
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const text = opts.singleLine
    ? raw.replace(/\s+/g, " ")
    : raw.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n");
  if (!text || text.length > opts.max) {
    throw new UserError(
      `Use a ${opts.label} from 1 to ${opts.max} characters.`,
      { code: ENTITY_ERRORS.invalid },
    );
  }
  return text;
}

/** Throw before an insert would pass a bound. */
export function assertRoom(count: number, limit: number, what: string): void {
  if (count >= limit) {
    throw new UserError(`This ${what} list is full (${limit}).`, {
      code: ENTITY_ERRORS.full,
    });
  }
}

/** SQLite has no booleans. */
export const bit = (value: boolean): number => (value ? 1 : 0);
