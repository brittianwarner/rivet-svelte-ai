import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { migrations } from "rivetkit/unstable/migrations";
import {
  authenticate,
  caller,
  createEntityVars,
  forbidden,
  forgetSession,
  publishTo,
  requireSystem,
  trackSession,
  ENTITY_OPTIONS,
  writer,
  type EntityVars,
  type PublishContext,
} from "../access.ts";
import {
  ENTITY_ERRORS,
  LIMITS,
  can,
  isRole,
  roleAtLeast,
  roleRank,
  type HistoryPage,
  type Invitation,
  type InvitationNotice,
  type Member,
  type OrganizationSnapshot,
  type Permission,
  type Principal,
  type ProjectLink,
  type Role,
} from "../contracts.ts";
import { assertRoom, cleanName } from "../input.ts";
import { assertId, parseKey, projectKey, userKey } from "../keys.ts";
import {
  OUTBOX_TABLE,
  createOutboxVars,
  enqueue,
  kickOutbox,
  outboxIdle,
  type OutboxHandlers,
  type OutboxHost,
  type OutboxRow,
  type OutboxVars,
} from "../outbox.ts";
import { asSystem, unlessMissing, type PeerHost } from "../peers.ts";
import { isSystem } from "../principal.ts";
import {
  LEDGER_TABLES,
  QUIET,
  commit,
  readAudit,
  readHistory,
  readMeta,
  seedLedger,
  select,
  type Store,
} from "../store.ts";
import type { OrganizationView } from "./user.ts";

const INVITATION_TTL = 7 * 24 * 60 * 60 * 1000;

/** Outbox kinds: what this organization tells other actors after a change. */
const SYNC_USER = "user";
const REVOKE = "revoke";
const START_PROJECT = "project.start";
const DESTROY_PROJECT = "project.destroy";

const organizationDb = db({
  onMigrate: migrations({
    migrations: [
      {
        version: 1,
        up: async (tx) => {
          await tx.execute(LEDGER_TABLES);
          await seedLedger(tx);
          await tx.execute(OUTBOX_TABLE);
          await tx.execute(`
            CREATE TABLE org (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              name TEXT NOT NULL DEFAULT '',
              owner_id TEXT
            );
            INSERT INTO org (id) VALUES (1);
            CREATE TABLE members (
              user_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT NOT NULL,
              joined_at INTEGER NOT NULL
            );
            CREATE TABLE invitations (
              invite_id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL UNIQUE,
              role TEXT NOT NULL,
              invited_by TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            -- 'starting' holds the slot while the project actor is created.
            CREATE TABLE projects (
              project_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              created_by TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('starting', 'ready'))
            );
          `);
        },
      },
    ],
  }),
});

interface OrganizationVars extends EntityVars {
  outbox: OutboxVars;
}

/** What the helpers below need from an action or hook context. */
interface OrganizationHost extends PublishContext, PeerHost, OutboxHost {
  key: readonly string[];
  vars: OrganizationVars;
}

function orgIdOf(key: readonly string[]): string {
  return parseKey(key, "organization")[0]!;
}

// ---------------------------------------------------------------- reads

async function readOrg(
  tx: RawAccess,
): Promise<{ name: string; ownerId: string | null }> {
  const [row] = await tx.execute<{ name: string; owner_id: string | null }>(
    "SELECT name, owner_id FROM org WHERE id = 1",
  );
  return { name: row?.name ?? "", ownerId: row?.owner_id ?? null };
}

async function roleOf(tx: RawAccess, userId: string): Promise<Role | null> {
  const [row] = await tx.execute<{ role: string }>(
    "SELECT role FROM members WHERE user_id = ?",
    userId,
  );
  return isRole(row?.role) ? row.role : null;
}

async function read(tx: RawAccess, id: string): Promise<OrganizationSnapshot> {
  return {
    id,
    ...(await readMeta(tx)),
    ...(await readOrg(tx)),
    members: await select<Member>(
      tx,
      "SELECT user_id AS userId, name, role, joined_at AS joinedAt FROM members ORDER BY joined_at, user_id",
    ),
    invitations: await select<Invitation>(
      tx,
      `SELECT invite_id AS inviteId, user_id AS userId, role, invited_by AS invitedBy,
              created_at AS createdAt, expires_at AS expiresAt
         FROM invitations WHERE expires_at > ? ORDER BY created_at, user_id`,
      Date.now(),
    ),
    projects: await select<ProjectLink>(
      tx,
      `SELECT project_id AS projectId, name, created_by AS createdBy, created_at AS createdAt
         FROM projects WHERE status = 'ready' ORDER BY created_at, project_id`,
    ),
    audit: await readAudit(tx),
    // Only mirrors that failed at least once: a sync in flight is not news.
    pendingSync: (
      await tx.execute<{ target: string }>(
        "SELECT target FROM outbox WHERE kind = ? AND attempts > 0 ORDER BY target",
        SYNC_USER,
      )
    ).map((row) => row.target),
  };
}

/** This organization as one user should see it. */
async function viewFor(
  tx: RawAccess,
  orgId: string,
  userId: string,
): Promise<OrganizationView> {
  const { revision } = await readMeta(tx);
  const { name } = await readOrg(tx);
  const [invite] = await tx.execute<{
    invite_id: string;
    role: Role;
    invited_by: string;
    expires_at: number;
  }>(
    "SELECT invite_id, role, invited_by, expires_at FROM invitations WHERE user_id = ? AND expires_at > ?",
    userId,
    Date.now(),
  );
  const invitation: InvitationNotice | null = invite
    ? {
        inviteId: invite.invite_id,
        orgId,
        orgName: name,
        role: invite.role,
        invitedBy: invite.invited_by,
        expiresAt: invite.expires_at,
      }
    : null;
  return { orgId, name, revision, role: await roleOf(tx, userId), invitation };
}

// ---------------------------------------------------------------- access

/** Snapshots reach current members only, so a removed member's open socket goes quiet. */
function store(c: OrganizationHost): Store<OrganizationSnapshot> {
  const id = orgIdOf(c.key);
  let members = new Set<string>();
  const send = publishTo(c, (principal) => members.has(principal.sub));
  return {
    db: c.db,
    read: async (tx) => {
      const next = await read(tx, id);
      members = new Set(next.members.map((member) => member.userId));
      return next;
    },
    publish: (next) => send("changed", next),
  };
}

/**
 * Check a permission inside the write's transaction, so a role change that
 * committed first is always seen. Returns the caller's role.
 */
async function authorize(
  tx: RawAccess,
  principal: Principal,
  permission: Permission,
): Promise<Role> {
  const { ownerId } = await readOrg(tx);
  if (!ownerId) {
    throw new UserError("This organization does not exist yet.", {
      code: ENTITY_ERRORS.notFound,
    });
  }
  const role = await roleOf(tx, principal.sub);
  if (!can(role, permission)) throw forbidden();
  return role!;
}

/** You can only hand out roles below your own. Owners can hand out anything but ownership. */
function assertCanGrant(actorRole: Role, role: Role): void {
  if (role === "owner")
    throw forbidden("Use transfer ownership to make someone an owner.");
  if (actorRole !== "owner" && roleRank(role) >= roleRank(actorRole)) {
    throw forbidden("You can only grant roles below your own.");
  }
}

function parseRole(value: unknown): Role {
  if (!isRole(value)) {
    throw new UserError("Choose viewer, member, admin, or owner.", {
      code: ENTITY_ERRORS.invalid,
    });
  }
  return value;
}

function notFound(message: string): UserError {
  return new UserError(message, { code: ENTITY_ERRORS.notFound });
}

async function count(
  tx: RawAccess,
  table: "members" | "invitations" | "projects",
): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(
    `SELECT count(*) AS n FROM ${table}`,
  );
  return row?.n ?? 0;
}

/** Ask a person's user actor whether they can join one more organization. */
async function assertCanJoin(c: PeerHost, userId: string): Promise<void> {
  const ok = await c
    .client()
    .user.getOrCreate(userKey(userId), asSystem())
    .canJoin();
  if (!ok) {
    throw new UserError(
      `You can belong to ${LIMITS.organizations} organizations. Leave one first.`,
      { code: ENTITY_ERRORS.full },
    );
  }
}

// ---------------------------------------------------------------- outbox

/** What each queued message does. Every handler reads fresh data. */
function deliveries(c: OrganizationHost): OutboxHandlers {
  const orgId = orgIdOf(c.key);
  return {
    deliver: async (row: OutboxRow) => {
      switch (row.kind) {
        case SYNC_USER: {
          const view = await c.db.transaction(
            (tx) => viewFor(tx, orgId, row.target),
            { name: "org.view" },
          );
          await c
            .client()
            .user.getOrCreate(userKey(row.target), asSystem())
            .applyOrganization(view);
          return;
        }
        case REVOKE: {
          // Someone who rejoined in the meantime keeps their sockets.
          if (await roleOf(c.db, row.target)) return;
          const projects = await c.db.execute<{ project_id: string }>(
            "SELECT project_id FROM projects WHERE status = 'ready'",
          );
          await Promise.all(
            projects.map(({ project_id }) =>
              unlessMissing(
                () =>
                  c
                    .client()
                    .project.get(projectKey(orgId, project_id), asSystem())
                    .revokeAccess(row.target),
                0,
              ),
            ),
          );
          return;
        }
        case START_PROJECT:
          await startProject(c, row.target);
          return;
        case DESTROY_PROJECT:
          await unlessMissing(
            () =>
              c
                .client()
                .project.get(projectKey(orgId, row.target), asSystem())
                .destroy(),
            false,
          );
          return;
        default:
          c.log.warn({ kind: row.kind }, "unknown outbox kind; dropping it");
      }
    },
    // A mirror that started or stopped failing changes `pendingSync`.
    settled: async ({ delivered, failed }) => {
      const visible =
        delivered.some((r) => r.kind === SYNC_USER && r.attempts > 0) ||
        failed.some((r) => r.kind === SYNC_USER && r.attempts === 0);
      if (visible) await commit(store(c), "org.sync", async () => QUIET);
    },
  };
}

function kick(c: OrganizationHost): void {
  kickOutbox(c, deliveries(c));
}

/**
 * Create the project actor, then list it. Idempotent: the outbox retries it
 * after a crash, and a retried `createProject` runs it again.
 */
async function startProject(
  c: OrganizationHost,
  projectId: string,
): Promise<void> {
  const [row] = await c.db.execute<{
    name: string;
    created_by: string;
    status: string;
  }>(
    "SELECT name, created_by, status FROM projects WHERE project_id = ?",
    projectId,
  );
  if (!row || row.status === "ready") return;
  await c
    .client()
    .project.getOrCreate(projectKey(orgIdOf(c.key), projectId), asSystem())
    .initialize({ name: row.name, createdBy: row.created_by });
  await commit(store(c), "project.ready", async (tx) => {
    const [ready] = await tx.execute<{ name: string }>(
      "UPDATE projects SET status = 'ready' WHERE project_id = ? AND status = 'starting' RETURNING name",
      projectId,
    );
    return ready
      ? {
          by: row.created_by,
          action: "project.create",
          summary: `Started ${ready.name}`,
        }
      : null;
  });
}

// ---------------------------------------------------------------- actor

/**
 * One actor per organization. Key: `["organization", orgId]`.
 *
 * The organization owns membership, roles, invitations, and the index of its
 * projects, in its own SQLite database. Each change commits in one
 * transaction together with the messages it owes other actors (the outbox):
 * fresh views for affected user mirrors, socket revocations for removed
 * members, and project starts and deletes. A slow or sleeping peer never
 * blocks the change and never misses it.
 */
export const organization = actor({
  options: ENTITY_OPTIONS,
  db: organizationDb,
  createVars: (): OrganizationVars => ({
    ...createEntityVars(),
    outbox: createOutboxVars(),
  }),
  /**
   * Any signed-in person may connect: creating an organization and answering
   * an invitation both happen before membership. Every action then checks the
   * caller's role.
   */
  onBeforeConnect: (c, params) => {
    authenticate(c, params);
  },
  onConnect: (c, conn) => trackSession(c, conn),
  onDisconnect: (c, conn) => forgetSession(c, conn),
  // Deliver anything the last wake left in the outbox.
  onWake: (c): void => kick(c),
  /**
   * No `canSubscribe` here: a refused subscription closes the whole socket and
   * the client reconnects at once, so a non-member's socket would loop.
   * `store` filters every change to current members instead.
   */
  events: { changed: event<OrganizationSnapshot>() },
  actions: {
    getSnapshot: (c): Promise<OrganizationSnapshot> => {
      const principal = caller(c);
      return c.db.transaction(
        async (tx) => {
          if (!isSystem(principal)) await authorize(tx, principal, "org.read");
          return read(tx, orgIdOf(c.key));
        },
        { name: "org.snapshot" },
      );
    },

    /** Older audit entries. Pass the previous page's `before`. */
    getHistory: (c, before?: unknown): Promise<HistoryPage> => {
      const principal = caller(c);
      return c.db.transaction(
        async (tx) => {
          await authorize(tx, principal, "org.read");
          return readHistory(tx, before);
        },
        { name: "org.history" },
      );
    },

    /**
     * Claim a new organization. The caller becomes its owner. Calling it again
     * as the owner is a no-op, so a retried create is safe.
     */
    create: async (
      c,
      input: { name?: unknown },
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      if (isSystem(principal))
        throw forbidden("A person must own an organization.");
      const { sub, name: displayName } = principal;
      const name = cleanName(input?.name, "organization name");
      if (!(await readOrg(c.db)).ownerId) await assertCanJoin(c, sub);
      const next = await commit(store(c), "org.create", async (tx) => {
        const { ownerId } = await readOrg(tx);
        if (ownerId === sub) return null;
        if (ownerId)
          throw new UserError("That organization id is taken.", {
            code: ENTITY_ERRORS.conflict,
          });
        await tx.execute(
          "UPDATE org SET name = ?, owner_id = ? WHERE id = 1",
          name,
          sub,
        );
        await tx.execute(
          "INSERT INTO members (user_id, name, role, joined_at) VALUES (?, ?, 'owner', ?)",
          sub,
          displayName,
          Date.now(),
        );
        await enqueue(tx, SYNC_USER, sub);
        return { by: sub, action: "org.create", summary: `Created ${name}` };
      });
      kick(c);
      return next;
    },

    rename: async (
      c,
      input: { name?: unknown },
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const name = cleanName(input?.name, "organization name");
      const next = await commit(store(c), "org.rename", async (tx) => {
        await authorize(tx, principal, "org.rename");
        const [renamed] = await tx.execute(
          "UPDATE org SET name = ? WHERE id = 1 AND name <> ? RETURNING id",
          name,
          name,
        );
        if (!renamed) return null;
        // Everyone whose mirror shows the name: members and invitees.
        const people = await tx.execute<{ user_id: string }>(
          "SELECT user_id FROM members UNION SELECT user_id FROM invitations",
        );
        for (const { user_id } of people) await enqueue(tx, SYNC_USER, user_id);
        return {
          by: principal.sub,
          action: "org.rename",
          summary: `Renamed to ${name}`,
        };
      });
      kick(c);
      return next;
    },

    invite: async (
      c,
      input: { userId?: unknown; role?: unknown },
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const userId = assertId(input?.userId, "user id");
      const role = parseRole(input?.role ?? "member");
      const next = await commit(store(c), "member.invite", async (tx) => {
        const actorRole = await authorize(tx, principal, "member.invite");
        assertCanGrant(actorRole, role);
        if (await roleOf(tx, userId)) {
          throw new UserError(`${userId} is already a member.`, {
            code: ENTITY_ERRORS.conflict,
          });
        }
        const now = Date.now();
        await tx.execute("DELETE FROM invitations WHERE expires_at <= ?", now);
        // A new invitation replaces an open one.
        await tx.execute("DELETE FROM invitations WHERE user_id = ?", userId);
        assertRoom(
          await count(tx, "invitations"),
          LIMITS.invitations,
          "invitation",
        );
        assertRoom(await count(tx, "members"), LIMITS.members, "member");
        await tx.execute(
          `INSERT INTO invitations (invite_id, user_id, role, invited_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(),
          userId,
          role,
          principal.sub,
          now,
          now + INVITATION_TTL,
        );
        await enqueue(tx, SYNC_USER, userId);
        return {
          by: principal.sub,
          action: "member.invite",
          summary: `Invited ${userId} as ${role}`,
        };
      });
      kick(c);
      return next;
    },

    revokeInvitation: async (
      c,
      inviteId: unknown,
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const next = await commit(store(c), "member.revoke", async (tx) => {
        await authorize(tx, principal, "member.invite");
        const [invite] = await tx.execute<{ user_id: string }>(
          "DELETE FROM invitations WHERE invite_id = ? RETURNING user_id",
          String(inviteId),
        );
        if (!invite) return null;
        await enqueue(tx, SYNC_USER, invite.user_id);
        return {
          by: principal.sub,
          action: "member.revoke",
          summary: `Revoked ${invite.user_id}'s invitation`,
        };
      });
      kick(c);
      return next;
    },

    /** The invitee answers. Accepting adds them with the invited role. */
    respond: async (
      c,
      input: { inviteId?: unknown; accept?: unknown },
    ): Promise<OrganizationSnapshot | null> => {
      const { sub, name } = writer(c);
      const accept = input?.accept === true;
      const inviteId = String(input?.inviteId);
      if (accept) await assertCanJoin(c, sub);
      const next = await commit(store(c), "member.respond", async (tx) => {
        const [invite] = await tx.execute<{ role: string }>(
          "DELETE FROM invitations WHERE invite_id = ? AND user_id = ? AND expires_at > ? RETURNING role",
          inviteId,
          sub,
          Date.now(),
        );
        if (!invite || !isRole(invite.role))
          throw notFound("This invitation is no longer open.");
        if (accept) {
          assertRoom(await count(tx, "members"), LIMITS.members, "member");
          await tx.execute(
            "INSERT INTO members (user_id, name, role, joined_at) VALUES (?, ?, ?, ?)",
            sub,
            name,
            invite.role,
            Date.now(),
          );
        }
        await enqueue(tx, SYNC_USER, sub);
        return {
          by: sub,
          action: accept ? "member.join" : "member.decline",
          summary: `${sub} ${accept ? "joined" : "declined"}`,
        };
      });
      kick(c);
      // A decliner can no longer read the organization.
      return accept ? next : null;
    },

    changeRole: async (
      c,
      input: { userId?: unknown; role?: unknown },
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const userId = assertId(input?.userId, "user id");
      const role = parseRole(input?.role);
      const next = await commit(store(c), "member.role", async (tx) => {
        const actorRole = await authorize(tx, principal, "member.role");
        const current = await roleOf(tx, userId);
        if (!current) throw notFound(`${userId} is not a member.`);
        if (current === "owner")
          throw forbidden("Transfer ownership to change the owner's role.");
        if (actorRole !== "owner" && !roleAtLeast(actorRole, current))
          throw forbidden();
        if (actorRole !== "owner" && current === actorRole)
          throw forbidden("Only the owner can change a peer's role.");
        assertCanGrant(actorRole, role);
        if (current === role) return null;
        await tx.execute(
          "UPDATE members SET role = ? WHERE user_id = ?",
          role,
          userId,
        );
        await enqueue(tx, SYNC_USER, userId);
        return {
          by: principal.sub,
          action: "member.role",
          summary: `${userId} is now ${role}`,
        };
      });
      kick(c);
      return next;
    },

    /** Remove someone, or leave yourself. The owner must transfer before leaving. */
    removeMember: async (
      c,
      userIdInput: unknown,
    ): Promise<OrganizationSnapshot | null> => {
      const userId = assertId(userIdInput, "user id");
      const principal = writer(c);
      const leaving = userId === principal.sub;
      const next = await commit(store(c), "member.remove", async (tx) => {
        const actorRole = await authorize(
          tx,
          principal,
          leaving ? "org.leave" : "member.remove",
        );
        const role = await roleOf(tx, userId);
        if (!role) return null;
        if (role === "owner")
          throw forbidden("The owner must transfer ownership first.");
        if (
          !leaving &&
          actorRole !== "owner" &&
          roleRank(role) >= roleRank(actorRole)
        ) {
          throw forbidden("You can only remove members below your role.");
        }
        await tx.execute("DELETE FROM members WHERE user_id = ?", userId);
        await enqueue(tx, SYNC_USER, userId);
        await enqueue(tx, REVOKE, userId);
        return {
          by: principal.sub,
          action: "member.remove",
          summary: leaving ? `${userId} left` : `Removed ${userId}`,
        };
      });
      kick(c);
      return leaving ? null : next;
    },

    transferOwnership: async (
      c,
      userIdInput: unknown,
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const userId = assertId(userIdInput, "user id");
      const next = await commit(store(c), "org.transfer", async (tx) => {
        await authorize(tx, principal, "org.transfer");
        if (userId === principal.sub || !(await roleOf(tx, userId))) {
          throw new UserError("Choose another member.", {
            code: ENTITY_ERRORS.invalid,
          });
        }
        await tx.execute(
          "UPDATE members SET role = CASE user_id WHEN ? THEN 'owner' ELSE 'admin' END WHERE user_id IN (?, ?)",
          userId,
          userId,
          principal.sub,
        );
        await tx.execute("UPDATE org SET owner_id = ? WHERE id = 1", userId);
        await enqueue(tx, SYNC_USER, userId);
        await enqueue(tx, SYNC_USER, principal.sub);
        return {
          by: principal.sub,
          action: "org.transfer",
          summary: `${userId} is now the owner`,
        };
      });
      kick(c);
      return next;
    },

    /**
     * Start a project. The caller picks the id, so a retried call returns the
     * same project instead of making a second one.
     *
     * The slot is reserved in one transaction, so two creates racing for the
     * last slot cannot both win. The project actor is created after commit,
     * and the outbox finishes the job if this call is cut short.
     */
    createProject: async (
      c,
      input: { projectId?: unknown; name?: unknown },
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const projectId = assertId(input?.projectId, "project id");
      const name = cleanName(input?.name, "project name");
      await c.db.transaction(
        async (tx) => {
          await authorize(tx, principal, "project.write");
          const [existing] = await tx.execute(
            "SELECT 1 FROM projects WHERE project_id = ?",
            projectId,
          );
          if (existing) return;
          assertRoom(await count(tx, "projects"), LIMITS.projects, "project");
          await tx.execute(
            "INSERT INTO projects (project_id, name, created_by, created_at, status) VALUES (?, ?, ?, ?, 'starting')",
            projectId,
            name,
            principal.sub,
            Date.now(),
          );
          await enqueue(tx, START_PROJECT, projectId);
        },
        { name: "project.reserve" },
      );
      try {
        await startProject(c, projectId);
      } finally {
        kick(c);
      }
      return c.db.transaction((tx) => read(tx, orgIdOf(c.key)), {
        name: "org.snapshot",
      });
    },

    /**
     * Delete a project and everything in it. The index entry goes now; the
     * project actor closes its sockets and destroys itself right after.
     */
    deleteProject: async (
      c,
      projectIdInput: unknown,
    ): Promise<OrganizationSnapshot> => {
      const principal = writer(c);
      const projectId = assertId(projectIdInput, "project id");
      const next = await commit(store(c), "project.delete", async (tx) => {
        await authorize(tx, principal, "project.delete");
        const [removed] = await tx.execute<{ name: string }>(
          "DELETE FROM projects WHERE project_id = ? RETURNING name",
          projectId,
        );
        if (!removed) return null;
        await enqueue(tx, DESTROY_PROJECT, projectId);
        return {
          by: principal.sub,
          action: "project.delete",
          summary: `Deleted ${removed.name}`,
        };
      });
      kick(c);
      return next;
    },

    /** Server-only. A project reports its latest name to the index. */
    applyProject: (
      c,
      input: { projectId?: unknown; name?: unknown },
    ): Promise<OrganizationSnapshot> => {
      requireSystem(c);
      const projectId = assertId(input?.projectId, "project id");
      const name = cleanName(input?.name, "project name");
      return commit(store(c), "project.rename", async (tx) => {
        const [renamed] = await tx.execute(
          "UPDATE projects SET name = ? WHERE project_id = ? AND name <> ? RETURNING project_id",
          name,
          projectId,
          name,
        );
        return renamed
          ? {
              by: "system",
              action: "project.rename",
              summary: `Project renamed to ${name}`,
            }
          : null;
      });
    },

    /**
     * Server-only. A project asks for a caller's role here before each action,
     * instead of copying membership. A project that is not in the index, or
     * is still starting, grants no one anything.
     */
    projectRole: async (
      c,
      input: { projectId?: unknown; userId?: unknown },
    ): Promise<Role | null> => {
      requireSystem(c);
      const projectId = assertId(input?.projectId, "project id");
      const userId = assertId(input?.userId, "user id");
      const [row] = await c.db.execute<{ role: string }>(
        `SELECT m.role FROM members m, projects p
          WHERE m.user_id = ? AND p.project_id = ? AND p.status = 'ready'`,
        userId,
        projectId,
      );
      return isRole(row?.role) ? row.role : null;
    },

    /** Cron, and the server. Deliver whatever is due in the outbox. */
    drainOutbox: async (c): Promise<void> => {
      if (!c.scheduledFire) requireSystem(c);
      kick(c);
      await outboxIdle(c);
    },
  },
});
