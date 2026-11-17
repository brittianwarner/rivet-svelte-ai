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
  type EntityContext,
  type EntityVars,
  type PublishContext,
} from "../access.ts";
import {
  ENTITY_ERRORS,
  LIMITS,
  isRole,
  type InvitationNotice,
  type OrganizationLink,
  type Principal,
  type Role,
  type UserSnapshot,
} from "../contracts.ts";
import { cleanName } from "../input.ts";
import { assertId, parseKey } from "../keys.ts";
import { isSystem } from "../principal.ts";
import {
  LEDGER_TABLES,
  commit,
  readMeta,
  seedLedger,
  select,
  snapshotOf,
  type Store,
} from "../store.ts";

/** What an organization tells a user about itself. Replaces the previous view. */
export interface OrganizationView {
  orgId: string;
  name: string;
  revision: number;
  /** The user's role, or null when they are not a member. */
  role: string | null;
  /** The open invitation, or null. */
  invitation: InvitationNotice | null;
}

/** How long a view from an organization the user left is remembered. */
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Schema. `org_views` is the mirror: one row per organization that has told
 * this user anything, with the last revision applied, so a late or repeated
 * view is ignored. A row with no role is a former membership.
 */
const userDb = db({
  onMigrate: migrations({
    migrations: [
      {
        version: 1,
        up: async (tx) => {
          await tx.execute(LEDGER_TABLES);
          await seedLedger(tx);
          await tx.execute(`
            CREATE TABLE profile (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              registered INTEGER NOT NULL DEFAULT 0,
              name TEXT,
              theme TEXT NOT NULL DEFAULT 'light'
            );
            INSERT INTO profile (id) VALUES (1);
            CREATE TABLE org_views (
              org_id TEXT PRIMARY KEY,
              revision INTEGER NOT NULL,
              name TEXT NOT NULL,
              role TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE inbox (
              org_id TEXT PRIMARY KEY,
              invite_id TEXT NOT NULL,
              org_name TEXT NOT NULL,
              role TEXT NOT NULL,
              invited_by TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              received_at INTEGER NOT NULL
            );
          `);
        },
      },
    ],
  }),
});

interface UserContext extends EntityContext {
  key: readonly string[];
}

function userIdOf(key: readonly string[]): string {
  return parseKey(key, "user")[0]!;
}

function hueFor(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

async function read(tx: RawAccess, id: string): Promise<UserSnapshot> {
  const [profile] = await tx.execute<{ name: string | null; theme: string }>(
    "SELECT name, theme FROM profile WHERE id = 1",
  );
  const organizations = await select<OrganizationLink>(
    tx,
    "SELECT org_id AS orgId, name, role FROM org_views WHERE role IS NOT NULL ORDER BY name, org_id",
  );
  const inbox = await select<InvitationNotice>(
    tx,
    `SELECT invite_id AS inviteId, org_id AS orgId, org_name AS orgName, role,
            invited_by AS invitedBy, expires_at AS expiresAt
       FROM inbox WHERE expires_at > ? ORDER BY received_at DESC`,
    Date.now(),
  );
  return {
    id,
    ...(await readMeta(tx)),
    profile: { name: profile?.name ?? id, hue: hueFor(id) },
    preferences: { theme: profile?.theme === "dark" ? "dark" : "light" },
    organizations,
    inbox,
  };
}

/** May this principal read and write this user actor? Only its own person, or the server. */
function owns(key: readonly string[], principal: Principal): boolean {
  return isSystem(principal) || principal.sub === userIdOf(key);
}

/** The calling person, who must be this user. `write` spends their write budget. */
function self(c: UserContext, write = false): Principal {
  const principal = write ? writer(c) : caller(c);
  if (principal.sub !== userIdOf(c.key))
    throw forbidden("Only this user can do that.");
  return principal;
}

/** Reads and writes for this user. Changes reach this user's own sockets only. */
function store(
  c: PublishContext & { db: RawAccess; key: readonly string[] },
): Store<UserSnapshot> {
  const id = userIdOf(c.key);
  const send = publishTo(c, (principal) => owns(c.key, principal));
  return {
    db: c.db,
    read: (tx) => read(tx, id),
    publish: (next) => send("changed", next),
  };
}

/**
 * One actor per person. Key: `["user", userId]`.
 *
 * The user actor owns the profile and preferences. It also keeps a mirror of
 * the organizations the person belongs to and the invitations waiting for
 * them, so a sign-in needs one connection to draw the account switcher.
 * Organizations own membership; this mirror is written only by them.
 */
export const user = actor({
  options: ENTITY_OPTIONS,
  db: userDb,
  createVars: (): EntityVars => createEntityVars(),
  // A user actor is private: only its own person, or the server, may connect.
  onBeforeConnect: (c, params) => {
    const { principal } = authenticate(c, params);
    if (!owns(c.key, principal)) throw forbidden("Only this user can do that.");
  },
  onConnect: (c, conn) => trackSession(c, conn),
  onDisconnect: (c, conn) => forgetSession(c, conn),
  events: {
    changed: event<UserSnapshot, UserContext>({
      canSubscribe: (c) => owns(c.key, caller(c)),
    }),
  },
  actions: {
    /** Read your own account. */
    getSnapshot: (c): Promise<UserSnapshot> => {
      self(c);
      return snapshotOf(store(c));
    },

    /** First sign-in copies the display name from the verified token. Idempotent. */
    register: (c): Promise<UserSnapshot> => {
      const { sub, name } = self(c, true);
      const clean = cleanName(name);
      return commit(store(c), "user.register", async (tx) => {
        const [row] = await tx.execute(
          "UPDATE profile SET registered = 1, name = ? WHERE id = 1 AND registered = 0 RETURNING id",
          clean,
        );
        return row
          ? { by: sub, action: "user.register", summary: "Account created" }
          : null;
      });
    },

    updateProfile: (c, input: { name?: unknown }): Promise<UserSnapshot> => {
      const { sub } = self(c, true);
      const name = cleanName(input?.name);
      return commit(store(c), "user.rename", async (tx) => {
        const [row] = await tx.execute(
          "UPDATE profile SET name = ? WHERE id = 1 AND name IS NOT ? RETURNING id",
          name,
          name,
        );
        return row
          ? { by: sub, action: "user.rename", summary: `Renamed to ${name}` }
          : null;
      });
    },

    setTheme: (c, theme: unknown): Promise<UserSnapshot> => {
      const { sub } = self(c, true);
      if (theme !== "light" && theme !== "dark") {
        throw new UserError("Theme must be light or dark.", {
          code: ENTITY_ERRORS.invalid,
        });
      }
      return commit(store(c), "user.theme", async (tx) => {
        const [row] = await tx.execute(
          "UPDATE profile SET theme = ? WHERE id = 1 AND theme <> ? RETURNING id",
          theme,
          theme,
        );
        return row
          ? { by: sub, action: "user.theme", summary: `Theme ${theme}` }
          : null;
      });
    },

    /**
     * Server-only. May this person join or start one more organization?
     * Organizations ask before `create` and before accepting an invitation.
     */
    canJoin: async (c): Promise<boolean> => {
      requireSystem(c);
      const [row] = await c.db.execute<{ n: number }>(
        "SELECT count(*) AS n FROM org_views WHERE role IS NOT NULL",
      );
      return (row?.n ?? 0) < LIMITS.organizations;
    },

    /**
     * Server-only. An organization replaces its view in this user's mirror.
     * Calls can arrive late or twice; the revision check makes them safe.
     */
    applyOrganization: (c, view: OrganizationView): Promise<UserSnapshot> => {
      requireSystem(c);
      const orgId = assertId(view?.orgId, "organization id");
      if (typeof view.revision !== "number")
        throw new UserError("A view needs a revision.", {
          code: ENTITY_ERRORS.invalid,
        });
      const role: Role | null = isRole(view.role) ? view.role : null;
      const name = String(view.name ?? orgId);
      return commit(store(c), "user.sync", async (tx) => {
        const now = Date.now();
        const [applied] = await tx.execute(
          `INSERT INTO org_views (org_id, revision, name, role, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (org_id) DO UPDATE SET revision = excluded.revision, name = excluded.name,
             role = excluded.role, updated_at = excluded.updated_at
           WHERE excluded.revision > org_views.revision
           RETURNING org_id`,
          orgId,
          view.revision,
          name,
          role,
          now,
        );
        if (!applied) return null;
        await tx.execute("DELETE FROM inbox WHERE org_id = ?", orgId);
        const invite = view.invitation;
        if (invite && isRole(invite.role) && invite.expiresAt > now) {
          await tx.execute(
            `INSERT INTO inbox (org_id, invite_id, org_name, role, invited_by, expires_at, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            orgId,
            String(invite.inviteId),
            name,
            invite.role,
            String(invite.invitedBy),
            invite.expiresAt,
            now,
          );
        }
        await prune(tx, now);
        return {
          by: "system",
          action: "user.sync",
          summary: `Updated from ${name}`,
        };
      });
    },
  },
});

/**
 * Keep the mirror bounded. Anyone can invite anyone, so the inbox keeps the
 * newest invitations only; the rest stay valid in their organization. Old
 * views of organizations the user left are forgotten.
 */
async function prune(tx: RawAccess, now: number): Promise<void> {
  await tx.execute("DELETE FROM inbox WHERE expires_at <= ?", now);
  await tx.execute(
    `DELETE FROM inbox WHERE org_id IN (
       SELECT org_id FROM inbox ORDER BY received_at DESC LIMIT -1 OFFSET ?)`,
    LIMITS.inbox,
  );
  await tx.execute(
    `DELETE FROM org_views WHERE role IS NULL AND updated_at < ?
       AND org_id NOT IN (SELECT org_id FROM inbox)`,
    now - FORGET_AFTER_MS,
  );
}
