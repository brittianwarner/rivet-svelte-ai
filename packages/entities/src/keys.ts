import { UserError } from "rivetkit";
import { ENTITY_ERRORS, isEntityId } from "./contracts.ts";

// Key builders live in the browser-safe contracts so views build the same keys.
export { organizationKey, projectKey, userKey } from "./contracts.ts";

/** A well-formed, unreserved id, or a validation error naming the field. */
export function assertId(value: unknown, label = "id"): string {
  if (!isEntityId(value)) {
    throw new UserError(
      `Use a valid ${label}: lowercase letters, digits, and dashes.`,
      { code: ENTITY_ERRORS.invalid },
    );
  }
  return value;
}

/**
 * Read the ids out of an actor key and check its shape.
 * `parseKey(c.key, "project", 2)` returns `[orgId, projectId]`.
 */
export function parseKey(
  key: readonly string[],
  kind: string,
  parts = 1,
): string[] {
  if (key.length !== parts + 1 || key[0] !== kind) {
    throw new UserError(`Expected a ${kind} key with ${parts} id(s).`, {
      code: ENTITY_ERRORS.invalid,
    });
  }
  return key.slice(1).map((part) => assertId(part, `${kind} id`));
}
