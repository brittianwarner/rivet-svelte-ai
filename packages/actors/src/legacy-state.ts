import { decode } from "cbor-x";
import type { MigrationDatabase } from "rivetkit/unstable/migrations";

/**
 * Carries pre-3.0 `c.state` forward into SQLite. RivetKit keeps the old state
 * as one CBOR row in its own `_rivet_actor_state` table; each actor's first
 * migration reads it here and copies what it recognizes into its own tables.
 *
 * This module exists only for actors created before the move to SQLite.
 * Delete it, and the import step in each version-1 migration, once no such
 * actors remain.
 *
 * Read-only on purpose: `_rivet_*` tables belong to RivetKit. Never write or
 * drop them.
 */
export async function readLegacyState(db: MigrationDatabase): Promise<unknown> {
  const tables = await db.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_rivet_actor_state'",
  );
  if (tables.length === 0) return undefined;

  const [row] = await db.execute<{ state: unknown }>(
    "SELECT state FROM _rivet_actor_state WHERE id = 1",
  );
  const bytes = toBytes(row?.state);
  if (!bytes) return undefined;
  try {
    return decode(bytes);
  } catch {
    // Unreadable bytes mean there is nothing to carry forward.
    return undefined;
  }
}

/** RivetKit's native SQLite binding returns a BLOB as an array of byte values. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(value);
  }
  return null;
}

/** Narrow a decoded value before reading its fields. Decoded state is untrusted. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole, non-negative number that JavaScript represents exactly. */
export function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
