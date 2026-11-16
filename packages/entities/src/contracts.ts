/**
 * Browser-safe contracts for the entity actors.
 *
 * Import this module from Svelte code. It has no server runtime, no secrets,
 * and no Rivet imports, so the same role rules can disable a button in the
 * browser and reject the action on the server.
 */

/**
 * Every entity key starts with its kind. `["user", "alice"]` and
 * `["organization", "alice"]` never collide, and a key that reaches the wrong
 * actor type fails loudly instead of creating an empty actor.
 */
export const userKey = (userId: string): string[] => ["user", userId];
export const organizationKey = (orgId: string): string[] => [
  "organization",
  orgId,
];
export const projectKey = (orgId: string, projectId: string): string[] => [
  "project",
  orgId,
  projectId,
];
/** One export job of one project. The job actor destroys itself when the file expires. */
export const exportKey = (
  orgId: string,
  projectId: string,
  exportId: string,
): string[] => ["export", orgId, projectId, exportId];

/** Lowercase ids keep actor keys stable and URL-safe. */
export const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Ids no entity may use. `system` names the server itself in audit entries
 * and actor-to-actor calls, so no person or organization can ever hold it.
 */
export const RESERVED_IDS: readonly string[] = ["system"];

/** True for a well-formed id that is not reserved. */
export function isEntityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ENTITY_ID_PATTERN.test(value) &&
    !RESERVED_IDS.includes(value)
  );
}

export const LIMITS = {
  /** Members kept in one organization actor. Shard larger orgs. */
  members: 200,
  /** Open invitations per organization. */
  invitations: 50,
  /** Organizations mirrored into one user's index. */
  organizations: 50,
  /** Pending invitations mirrored into one user's inbox. */
  inbox: 20,
  /** Newest audit entries in each snapshot. Older ones are paged with `getHistory`. */
  audit: 50,
  /** Audit entries kept per entity. Older entries are deleted. */
  auditRetained: 1_000,
  /** Audit entries per `getHistory` page. */
  historyPage: 50,
  /** Projects indexed by one organization. */
  projects: 50,
  /** Tasks per project. Every task rides in each snapshot, so keep this small. */
  tasks: 100,
  /** Comments per task. Comments are paged, never sent all at once. */
  comments: 500,
  /** Comments per `listComments` page. */
  commentPage: 20,
  /** Characters in one comment. */
  comment: 2_000,
  /** Recent exports listed per project. Older ones drop off the list. */
  exports: 10,
  /** Characters in names and titles. */
  name: 64,
} as const;

/** Roles, weakest first. A role includes every permission of the roles before it. */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** The smallest role that grants each permission. */
export const PERMISSIONS = {
  "org.read": "viewer",
  "org.leave": "viewer",
  "project.read": "viewer",
  "project.write": "member",
  "project.delete": "admin",
  "org.rename": "admin",
  "member.invite": "admin",
  "member.remove": "admin",
  "member.role": "admin",
  "org.transfer": "owner",
} as const satisfies Record<string, Role>;
export type Permission = keyof typeof PERMISSIONS;

/** Permissions that only read. Every other permission changes state. */
export function isReadPermission(permission: Permission): boolean {
  return permission.endsWith(".read");
}

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** True when `role` meets or exceeds `minimum`. */
export function roleAtLeast(
  role: Role | null | undefined,
  minimum: Role,
): boolean {
  return role != null && roleRank(role) >= roleRank(minimum);
}

/** True when `role` grants `permission`. A missing role grants nothing. */
export function can(
  role: Role | null | undefined,
  permission: Permission,
): boolean {
  return roleAtLeast(role, PERMISSIONS[permission]);
}

/** Who is calling. `system` is reserved for actor-to-actor calls. */
export interface Principal {
  /** A user id, or `system` for server-owned calls. */
  sub: string;
  /** Display name carried in the signed token. */
  name: string;
}

export interface AuditEntry {
  /** Increases with each entry. Page older history with `before: id`. */
  id: number;
  at: number;
  by: string;
  action: string;
  summary: string;
}

/** Fields every entity snapshot carries, so views can reconcile out-of-order updates. */
export interface EntityMeta {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserProfile {
  name: string;
  /** Accent hue from 0 to 359 for avatars. */
  hue: number;
}

export interface UserPreferences {
  theme: "light" | "dark";
}

/** A user's view of one organization they belong to. */
export interface OrganizationLink {
  orgId: string;
  name: string;
  role: Role;
}

/** An invitation waiting in a user's inbox. */
export interface InvitationNotice {
  inviteId: string;
  orgId: string;
  orgName: string;
  role: Role;
  invitedBy: string;
  expiresAt: number;
}

export interface UserSnapshot extends EntityMeta {
  profile: UserProfile;
  preferences: UserPreferences;
  organizations: OrganizationLink[];
  inbox: InvitationNotice[];
}

export interface Member {
  userId: string;
  name: string;
  role: Role;
  joinedAt: number;
}

export interface Invitation {
  inviteId: string;
  userId: string;
  role: Role;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/** The organization's index entry for one project. The project actor owns the rest. */
export interface ProjectLink {
  projectId: string;
  name: string;
  createdBy: string;
  createdAt: number;
}

export interface OrganizationSnapshot extends EntityMeta {
  name: string;
  ownerId: string | null;
  members: Member[];
  invitations: Invitation[];
  projects: ProjectLink[];
  audit: AuditEntry[];
  /** User actors whose mirrors are still catching up. */
  pendingSync: string[];
}

export interface Task {
  taskId: string;
  title: string;
  done: boolean;
  createdBy: string;
  createdAt: number;
  /** How many comments the task has. Read them with `listComments`. */
  comments: number;
}

export interface Comment {
  commentId: number;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
}

/** One page of a task's comments, oldest first. Pass `before` for the page before it. */
export interface CommentPage {
  comments: Comment[];
  /** The `before` cursor for older comments, or null at the start. */
  before: number | null;
}

/** A page of audit history, oldest first. */
export interface HistoryPage {
  entries: AuditEntry[];
  before: number | null;
}

/** Someone with the project open right now. Never stored. */
export interface Viewer {
  userId: string;
  name: string;
}

export type ExportStatus = "queued" | "running" | "ready" | "failed";

/** The project's record of one export. The export actor reports each change. */
export interface ExportLink {
  exportId: string;
  requestedBy: string;
  status: ExportStatus;
  createdAt: number;
  /** Rows in the file, once ready. */
  rows: number | null;
  /** File size in bytes, once ready. */
  bytes: number | null;
  /** When the file is deleted. */
  expiresAt: number;
  /** Plain-language reason when `status` is `failed`. */
  error: string | null;
}

export interface ProjectSnapshot extends EntityMeta {
  orgId: string;
  name: string;
  tasks: Task[];
  /** The newest exports, newest first. */
  exports: ExportLink[];
  audit: AuditEntry[];
}

/** Connection params every entity actor accepts. */
export interface EntityConnParams {
  /** Signed principal token from the API. */
  principal?: string;
  /** Optional transport token for the starter's demo gate. */
  token?: string;
}

/** Stable error codes. Views map these to plain-language messages. */
export const ENTITY_ERRORS = {
  unauthenticated: "UNAUTHENTICATED",
  forbidden: "FORBIDDEN",
  invalid: "VALIDATION_FAILED",
  notFound: "NOT_FOUND",
  conflict: "CONFLICT",
  full: "LIMIT_REACHED",
  rateLimited: "RATE_LIMITED",
} as const;

/**
 * Why an entity actor closed a socket, as `group.code`. The client reconnects
 * on its own: an expired session comes back with a fresh token, a revoked
 * member is refused at connect. Stay out of the `auth` group: Rivet's client
 * reads `auth.token_expired` as its own gateway token and stops reconnecting.
 */
export const ENTITY_CLOSE_REASONS = {
  accessRevoked: "user.access_revoked",
  sessionExpired: "user.session_expired",
  deleted: "user.entity_deleted",
} as const;
