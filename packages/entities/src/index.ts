/**
 * @example/entities — user, organization, and project actors, plus the small
 * framework they are built from. Server-only: browser code imports
 * `@example/entities/contracts`.
 */
import { organization } from "./actors/organization.ts";
import { projectExport } from "./actors/project-export.ts";
import { project } from "./actors/project.ts";
import { user } from "./actors/user.ts";

export * from "./contracts.ts";
export { assertId, parseKey } from "./keys.ts";
export { assertRoom, bit, cleanName, cleanText } from "./input.ts";
export {
  LEDGER_TABLES,
  QUIET,
  commit,
  readAudit,
  readHistory,
  readMeta,
  seedLedger,
  snapshotOf,
  type Change,
  type Meta,
  type Store,
  type WriteResult,
} from "./store.ts";
export {
  OUTBOX_TABLE,
  createOutboxVars,
  enqueue,
  kickOutbox,
  outboxIdle,
  waiting,
  type OutboxHandlers,
  type OutboxHost,
  type OutboxRow,
  type OutboxVars,
} from "./outbox.ts";
export {
  asSystem,
  isMissingActor,
  unlessMissing,
  type PeerHost,
} from "./peers.ts";
export {
  authenticate,
  caller,
  createEntityVars,
  forbidden,
  forgetSession,
  publishTo,
  requireSystem,
  sessionPrincipal,
  trackSession,
  unauthenticated,
  writer,
  type EntityConn,
  type EntityContext,
  type EntityVars,
  type PublishContext,
} from "./access.ts";
export {
  SYSTEM,
  configureEntities,
  entityFiles,
  exportTtlMs,
  isSystem,
  signPrincipal,
  systemParams,
  verifyPrincipal,
  type Session,
} from "./principal.ts";
export type { EntityRegistry } from "./registry-types.ts";
export type { OrganizationView } from "./actors/user.ts";
export type { ExportSource } from "./actors/project.ts";
export type { ExportJob } from "./actors/project-export.ts";
export { organization, project, projectExport, user };

/** Spread into `setup({ use: { ...entityActors } })`. The names matter. */
export const entityActors = { user, organization, project, projectExport };
