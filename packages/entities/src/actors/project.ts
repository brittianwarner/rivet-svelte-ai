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
  sessionPrincipal,
  trackSession,
  writer,
  type EntityContext,
  type EntityVars,
  type PublishContext,
} from "../access.ts";
import {
  ENTITY_CLOSE_REASONS,
  ENTITY_ERRORS,
  LIMITS,
  can,
  exportKey,
  isReadPermission,
  type Comment,
  type CommentPage,
  type ExportLink,
  type ExportStatus,
  type HistoryPage,
  type Permission,
  type Principal,
  type ProjectSnapshot,
  type Role,
  type Task,
  type Viewer,
} from "../contracts.ts";
import { assertRoom, cleanName, cleanText } from "../input.ts";
import { organizationKey, parseKey } from "../keys.ts";
import {
  OUTBOX_TABLE,
  createOutboxVars,
  enqueue,
  kickOutbox,
  outboxIdle,
  type OutboxHandlers,
  type OutboxHost,
  type OutboxVars,
} from "../outbox.ts";
import { asSystem, unlessMissing, type PeerHost } from "../peers.ts";
import { exportTtlMs, isSystem } from "../principal.ts";
import {
  LEDGER_TABLES,
  QUIET,
  commit,
  readAudit,
  readHistory,
  readMeta,
  seedLedger,
  select,
  snapshotOf,
  type Store,
} from "../store.ts";

/**
 * The template for your own entities.
 *
 * A project lives inside an organization. Key: `["project", orgId, projectId]`.
 * It owns its own data (tasks, comments, exports) in its own SQLite database,
 * and never copies membership: before each action it asks the organization
 * for the caller's role, so a removed member loses access on their very next
 * call.
 *
 * The organization starts each project (`createProject`) and keeps the index
 * of them. A key nobody started reads as not found, so guessing a key never
 * creates a visible project.
 *
 * Copy this file, rename the tables and actions, keep the moves:
 *   1. `parseKey` to read ids from the key,
 *   2. the connection hooks: `authenticate` in `onBeforeConnect`, then
 *      `trackSession` / `forgetSession` in `onConnect` / `onDisconnect`,
 *   3. `allow` to ask the owning organization before each action,
 *   4. `commit(store(c), …)` for every write, with checks inside it,
 *   5. `enqueue` + `kick` for anything another actor must hear about.
 */

/** Outbox kinds. */
const SYNC_NAME = "org.name";
const START_EXPORT = "export.start";

const projectDb = db({
  onMigrate: migrations({
    migrations: [
      {
        version: 1,
        up: async (tx) => {
          await tx.execute(LEDGER_TABLES);
          await seedLedger(tx);
          await tx.execute(OUTBOX_TABLE);
          await tx.execute(`
            CREATE TABLE project (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              name TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO project (id) VALUES (1);
            CREATE TABLE tasks (
              task_id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              done INTEGER NOT NULL DEFAULT 0,
              created_by TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              comments INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              author_id TEXT NOT NULL,
              author_name TEXT NOT NULL,
              body TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX comments_by_task ON comments (task_id, id);
            CREATE TABLE exports (
              export_id TEXT PRIMARY KEY,
              requested_by TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              rows INTEGER,
              bytes INTEGER,
              expires_at INTEGER NOT NULL,
              error TEXT
            );
          `);
        },
      },
    ],
  }),
});

/** What an export actor gets to build its file from. */
export interface ExportSource {
  projectName: string;
  tasks: Task[];
  /** When the file must be deleted. */
  expiresAt: number;
}

interface ProjectVars extends EntityVars {
  outbox: OutboxVars;
  /** Who has the project open, by connection. Presence is never stored. */
  viewers: Map<string, Viewer>;
}

interface ProjectHost extends PublishContext, PeerHost, OutboxHost {
  key: readonly string[];
  vars: ProjectVars;
}

interface ProjectContext extends EntityContext, PeerHost {
  key: readonly string[];
  db: RawAccess;
}

function idsOf(key: readonly string[]): { orgId: string; projectId: string } {
  const [orgId, projectId] = parseKey(key, "project", 2);
  return { orgId: orgId!, projectId: projectId! };
}

// ---------------------------------------------------------------- reads

async function nameOf(tx: RawAccess): Promise<string> {
  const [row] = await tx.execute<{ name: string }>(
    "SELECT name FROM project WHERE id = 1",
  );
  return row?.name ?? "";
}

const TASK_COLUMNS = `task_id AS taskId, title, done, created_by AS createdBy,
  created_at AS createdAt, comments`;

function toTask(row: Omit<Task, "done"> & { done: number }): Task {
  return { ...row, done: row.done === 1 };
}

const EXPORT_COLUMNS = `export_id AS exportId, requested_by AS requestedBy, status,
  created_at AS createdAt, rows, bytes, expires_at AS expiresAt, error`;

async function read(
  tx: RawAccess,
  ids: { orgId: string; projectId: string },
): Promise<ProjectSnapshot> {
  const tasks = await tx.execute<Omit<Task, "done"> & { done: number }>(
    `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, task_id`,
  );
  return {
    id: ids.projectId,
    orgId: ids.orgId,
    ...(await readMeta(tx)),
    name: await nameOf(tx),
    tasks: tasks.map(toTask),
    exports: await select<ExportLink>(
      tx,
      `SELECT ${EXPORT_COLUMNS} FROM exports ORDER BY created_at DESC LIMIT ?`,
      LIMITS.exports,
    ),
    audit: await readAudit(tx),
  };
}

// ---------------------------------------------------------------- access

/** The caller's role, straight from the owning organization. Never cached. */
async function roleIn(c: ProjectContext, userId: string): Promise<Role | null> {
  const { orgId, projectId } = idsOf(c.key);
  return unlessMissing(
    () =>
      c
        .client()
        .organization.get(organizationKey(orgId), asSystem())
        .projectRole({ projectId, userId }),
    null,
  );
}

/** May this principal read the project? The server always may. */
async function canRead(
  c: ProjectContext,
  principal: Principal,
): Promise<boolean> {
  return (
    isSystem(principal) || can(await roleIn(c, principal.sub), "project.read")
  );
}

/**
 * Ask the owning organization whether the caller may do this. Reads use the
 * caller's session; writes also spend their write budget.
 */
async function allow(
  c: ProjectContext,
  permission: Permission,
): Promise<Principal & { role: Role }> {
  const principal = isReadPermission(permission) ? caller(c) : writer(c);
  if (!(await nameOf(c.db)))
    throw new UserError("This project does not exist.", {
      code: ENTITY_ERRORS.notFound,
    });
  const role = await roleIn(c, principal.sub);
  if (!can(role, permission)) throw forbidden();
  return { ...principal, role: role! };
}

/**
 * Changes reach every live session. Membership was checked at connect, and
 * the organization closes a removed member's sockets through `revokeAccess`.
 */
function store(c: ProjectHost): Store<ProjectSnapshot> {
  const ids = idsOf(c.key);
  const send = publishTo(c);
  return {
    db: c.db,
    read: (tx) => read(tx, ids),
    publish: (next) => send("changed", next),
  };
}

function notFound(message: string): UserError {
  return new UserError(message, { code: ENTITY_ERRORS.notFound });
}

function viewersOf(vars: ProjectVars): Viewer[] {
  const byUser = new Map<string, Viewer>();
  for (const viewer of vars.viewers.values()) byUser.set(viewer.userId, viewer);
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function publishViewers(c: ProjectHost): void {
  publishTo(c)("presence", viewersOf(c.vars));
}

// ---------------------------------------------------------------- outbox

function deliveries(c: ProjectHost): OutboxHandlers {
  const { orgId, projectId } = idsOf(c.key);
  return {
    deliver: async (row) => {
      switch (row.kind) {
        case SYNC_NAME: {
          // Send the latest name, whatever it is now. A deleted org is fine.
          const name = await nameOf(c.db);
          await unlessMissing(
            () =>
              c
                .client()
                .organization.get(organizationKey(orgId), asSystem())
                .applyProject({ projectId, name }),
            null,
          );
          return;
        }
        case START_EXPORT: {
          const [open] = await c.db.execute(
            "SELECT 1 FROM exports WHERE export_id = ? AND status = 'queued'",
            row.target,
          );
          if (!open) return;
          // Creating the export actor starts its workflow.
          await c
            .client()
            .projectExport.getOrCreate(
              exportKey(orgId, projectId, row.target),
              asSystem(),
            )
            .getStatus();
          return;
        }
        default:
          c.log.warn({ kind: row.kind }, "unknown outbox kind; dropping it");
      }
    },
  };
}

function kick(c: ProjectHost): void {
  kickOutbox(c, deliveries(c));
}

// ---------------------------------------------------------------- actor

export const project = actor({
  db: projectDb,
  createVars: (): ProjectVars => ({
    ...createEntityVars(),
    outbox: createOutboxVars(),
    viewers: new Map(),
  }),
  /**
   * Only people who can read the project may hold a socket, because every
   * open socket receives each change.
   */
  onBeforeConnect: async (c, params) => {
    const { principal } = authenticate(c, params);
    if (!(await canRead(c, principal))) throw forbidden();
  },
  onConnect: (c, conn) => trackSession(c, conn),
  onDisconnect: (c, conn) => {
    forgetSession(c, conn);
    if (c.vars.viewers.delete(conn.id)) publishViewers(c);
  },
  onWake: (c): void => kick(c),
  events: {
    changed: event<ProjectSnapshot, ProjectContext>({
      canSubscribe: (c) => canRead(c, caller(c)),
    }),
    /** A new comment, so open threads append it without a refetch. */
    comment: event<Comment, ProjectContext>({
      canSubscribe: (c) => canRead(c, caller(c)),
    }),
    /** Who has the project open right now. */
    presence: event<Viewer[], ProjectContext>({
      canSubscribe: (c) => canRead(c, caller(c)),
    }),
  },
  actions: {
    /** Server-only. The organization calls this once from `createProject`. Idempotent. */
    initialize: (
      c,
      input: { name?: unknown; createdBy?: unknown },
    ): Promise<ProjectSnapshot> => {
      requireSystem(c);
      const name = cleanName(input?.name, "project name");
      return commit(store(c), "project.create", async (tx) => {
        const [started] = await tx.execute(
          "UPDATE project SET name = ? WHERE id = 1 AND name = '' RETURNING id",
          name,
        );
        return started
          ? {
              by:
                typeof input?.createdBy === "string"
                  ? input.createdBy
                  : "system",
              action: "project.create",
              summary: `Started ${name}`,
            }
          : null;
      });
    },

    /** Server-only. Close every socket this user holds here. */
    revokeAccess: async (c, userId: unknown): Promise<number> => {
      requireSystem(c);
      // `sessionPrincipal` rebuilds sessions an actor lost while asleep.
      const closing = [...c.conns.values()].filter(
        (conn) => sessionPrincipal(c, conn)?.sub === userId,
      );
      await Promise.all(
        closing.map((conn) =>
          conn.disconnect(ENTITY_CLOSE_REASONS.accessRevoked),
        ),
      );
      return closing.length;
    },

    /**
     * Server-only. The organization deleted this project: close every socket,
     * then delete the actor and its database for good.
     */
    destroy: async (c): Promise<boolean> => {
      requireSystem(c);
      await Promise.all(
        [...c.conns.values()].map((conn) =>
          conn.disconnect(ENTITY_CLOSE_REASONS.deleted).catch(() => undefined),
        ),
      );
      c.destroy();
      return true;
    },

    getSnapshot: async (c): Promise<ProjectSnapshot> => {
      await allow(c, "project.read");
      return snapshotOf(store(c));
    },

    /** Older audit entries. Pass the previous page's `before`. */
    getHistory: async (c, before?: unknown): Promise<HistoryPage> => {
      await allow(c, "project.read");
      return c.db.transaction((tx) => readHistory(tx, before), {
        name: "project.history",
      });
    },

    rename: async (c, name: unknown): Promise<ProjectSnapshot> => {
      const { sub } = await allow(c, "project.write");
      const clean = cleanName(name, "project name");
      const next = await commit(store(c), "project.rename", async (tx) => {
        const [renamed] = await tx.execute(
          "UPDATE project SET name = ? WHERE id = 1 AND name <> ? RETURNING id",
          clean,
          clean,
        );
        if (!renamed) return null;
        // The organization's index learns the name after commit.
        await enqueue(tx, SYNC_NAME, idsOf(c.key).orgId);
        return { by: sub, action: "project.rename", summary: `Named ${clean}` };
      });
      kick(c);
      return next;
    },

    addTask: async (c, title: unknown): Promise<ProjectSnapshot> => {
      const { sub } = await allow(c, "project.write");
      const clean = cleanName(title, "task title");
      return commit(store(c), "task.add", async (tx) => {
        const [row] = await tx.execute<{ n: number }>(
          "SELECT count(*) AS n FROM tasks",
        );
        assertRoom(row?.n ?? 0, LIMITS.tasks, "task");
        await tx.execute(
          "INSERT INTO tasks (task_id, title, created_by, created_at) VALUES (?, ?, ?, ?)",
          crypto.randomUUID(),
          clean,
          sub,
          Date.now(),
        );
        return { by: sub, action: "task.add", summary: `Added ${clean}` };
      });
    },

    toggleTask: async (c, taskId: unknown): Promise<ProjectSnapshot> => {
      const { sub } = await allow(c, "project.write");
      return commit(store(c), "task.toggle", async (tx) => {
        // One statement, so two quick toggles always land as two flips.
        const [task] = await tx.execute<{ title: string; done: number }>(
          "UPDATE tasks SET done = 1 - done WHERE task_id = ? RETURNING title, done",
          String(taskId),
        );
        if (!task) throw notFound("That task no longer exists.");
        return {
          by: sub,
          action: "task.toggle",
          summary: `${task.done ? "Done" : "Reopened"}: ${task.title}`,
        };
      });
    },

    /** Delete a task and its comments. */
    removeTask: async (c, taskId: unknown): Promise<ProjectSnapshot> => {
      const { sub } = await allow(c, "project.write");
      return commit(store(c), "task.remove", async (tx) => {
        await tx.execute(
          "DELETE FROM comments WHERE task_id = ?",
          String(taskId),
        );
        const [task] = await tx.execute<{ title: string }>(
          "DELETE FROM tasks WHERE task_id = ? RETURNING title",
          String(taskId),
        );
        if (!task) return null;
        return {
          by: sub,
          action: "task.remove",
          summary: `Removed ${task.title}`,
        };
      });
    },

    /**
     * Comment on a task. Comments live in their own table and are paged, so a
     * long thread never rides in the snapshot. The snapshot carries the count.
     */
    addComment: async (
      c,
      input: { taskId?: unknown; body?: unknown },
    ): Promise<Comment> => {
      const { sub, name } = await allow(c, "project.write");
      const taskId = String(input?.taskId);
      const body = cleanText(input?.body, {
        label: "comment",
        max: LIMITS.comment,
      });
      let added: Comment | undefined;
      await commit(store(c), "comment.add", async (tx) => {
        const [task] = await tx.execute<{ title: string; comments: number }>(
          "SELECT title, comments FROM tasks WHERE task_id = ?",
          taskId,
        );
        if (!task) throw notFound("That task no longer exists.");
        assertRoom(task.comments, LIMITS.comments, "comment");
        const createdAt = Date.now();
        const [row] = await tx.execute<{ id: number }>(
          `INSERT INTO comments (task_id, author_id, author_name, body, created_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
          taskId,
          sub,
          name,
          body,
          createdAt,
        );
        await tx.execute(
          "UPDATE tasks SET comments = comments + 1 WHERE task_id = ?",
          taskId,
        );
        added = {
          commentId: row!.id,
          taskId,
          authorId: sub,
          authorName: name,
          body,
          createdAt,
        };
        return {
          by: sub,
          action: "comment.add",
          summary: `Commented on ${task.title}`,
        };
      });
      publishTo(c)("comment", added);
      return added!;
    },

    /** A page of a task's comments, oldest first. Pass `before` for older ones. */
    listComments: async (
      c,
      input: { taskId?: unknown; before?: unknown },
    ): Promise<CommentPage> => {
      await allow(c, "project.read");
      const before =
        typeof input?.before === "number" && Number.isSafeInteger(input.before)
          ? input.before
          : Number.MAX_SAFE_INTEGER;
      // One more than a page tells us whether older comments exist.
      const rows = await c.db.execute<{
        id: number;
        task_id: string;
        author_id: string;
        author_name: string;
        body: string;
        created_at: number;
      }>(
        `SELECT id, task_id, author_id, author_name, body, created_at FROM comments
          WHERE task_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        String(input?.taskId),
        before,
        LIMITS.commentPage + 1,
      );
      const page = rows.slice(0, LIMITS.commentPage).reverse();
      return {
        comments: page.map((row) => ({
          commentId: row.id,
          taskId: row.task_id,
          authorId: row.author_id,
          authorName: row.author_name,
          body: row.body,
          createdAt: row.created_at,
        })),
        before: rows.length > LIMITS.commentPage ? page[0]!.id : null,
      };
    },

    /**
     * Mark this connection as viewing the project and return who else is.
     * Presence lives in `c.vars`: it is about open sockets, so it should
     * vanish when they do. Call it again after each reconnect.
     */
    watch: async (c): Promise<Viewer[]> => {
      const principal = await allow(c, "project.read");
      if (c.conn && !isSystem(principal)) {
        c.vars.viewers.set(c.conn.id, {
          userId: principal.sub,
          name: principal.name,
        });
        publishViewers(c);
      }
      return viewersOf(c.vars);
    },

    /**
     * Start a CSV export. A `projectExport` actor builds the file in a durable
     * workflow, reports back here, and deletes itself when the file expires.
     */
    startExport: async (c): Promise<ProjectSnapshot> => {
      // Exports only read, but they cost work: spend the write budget too.
      writer(c);
      const { sub } = await allow(c, "project.read");
      const exportId = crypto.randomUUID();
      const next = await commit(store(c), "export.start", async (tx) => {
        const [busy] = await tx.execute(
          "SELECT 1 FROM exports WHERE requested_by = ? AND status IN ('queued', 'running')",
          sub,
        );
        if (busy)
          throw new UserError("Your last export is still running.", {
            code: ENTITY_ERRORS.conflict,
          });
        const now = Date.now();
        await tx.execute(
          `INSERT INTO exports (export_id, requested_by, status, created_at, expires_at)
           VALUES (?, ?, 'queued', ?, ?)`,
          exportId,
          sub,
          now,
          now + exportTtlMs(),
        );
        // The list shows the newest few. Older files still expire on time.
        await tx.execute(
          `DELETE FROM exports WHERE export_id IN (
             SELECT export_id FROM exports ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
          LIMITS.exports,
        );
        await enqueue(tx, START_EXPORT, exportId);
        return {
          by: sub,
          action: "export.start",
          summary: "Started a CSV export",
        };
      });
      kick(c);
      return next;
    },

    /**
     * Server-only. The export actor asks for its rows. Null means there is no
     * such export, so the export actor deletes itself: an export actor some
     * client created by guessing a key never gets data.
     */
    exportSource: async (
      c,
      exportId: unknown,
    ): Promise<ExportSource | null> => {
      requireSystem(c);
      return c.db.transaction(
        async (tx) => {
          const [open] = await tx.execute<{ expires_at: number }>(
            "SELECT expires_at FROM exports WHERE export_id = ? AND status IN ('queued', 'running')",
            String(exportId),
          );
          if (!open) return null;
          const tasks = await tx.execute<Omit<Task, "done"> & { done: number }>(
            `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at, task_id`,
          );
          return {
            projectName: await nameOf(tx),
            tasks: tasks.map(toTask),
            expiresAt: open.expires_at,
          };
        },
        { name: "export.source" },
      );
    },

    /** Server-only. The export actor reports progress. */
    applyExport: async (
      c,
      input: {
        exportId?: unknown;
        status?: unknown;
        rows?: unknown;
        bytes?: unknown;
        error?: unknown;
      },
    ): Promise<boolean> => {
      requireSystem(c);
      const exportId = String(input?.exportId);
      const status = input?.status;
      if (status === "expired") {
        await commit(store(c), "export.expire", async (tx) => {
          const [gone] = await tx.execute(
            "DELETE FROM exports WHERE export_id = ? RETURNING export_id",
            exportId,
          );
          return gone ? QUIET : null;
        });
        return true;
      }
      if (status !== "running" && status !== "ready" && status !== "failed")
        throw new UserError("Unknown export status.", {
          code: ENTITY_ERRORS.invalid,
        });
      const rows = typeof input.rows === "number" ? input.rows : null;
      const bytes = typeof input.bytes === "number" ? input.bytes : null;
      const error = typeof input.error === "string" ? input.error : null;
      let known = false;
      await commit(store(c), "export.apply", async (tx) => {
        const [row] = await tx.execute<{ requested_by: string }>(
          `UPDATE exports SET status = ?, rows = ?, bytes = ?, error = ?
            WHERE export_id = ? AND status <> ? RETURNING requested_by`,
          status satisfies ExportStatus,
          rows,
          bytes,
          error,
          exportId,
          status,
        );
        if (!row) return null;
        known = true;
        if (status === "running") return QUIET;
        return {
          by: "system",
          action: `export.${status}`,
          summary:
            status === "ready"
              ? `Export ready (${rows ?? 0} tasks)`
              : `Export failed: ${error ?? "unknown error"}`,
        };
      });
      return known;
    },

    /**
     * Server-only. May this user download this export? Anyone who can read
     * the project may: the file holds nothing they cannot already see.
     */
    exportAccess: async (
      c,
      input: { exportId?: unknown; userId?: unknown },
    ): Promise<boolean> => {
      requireSystem(c);
      const [row] = await c.db.execute(
        "SELECT 1 FROM exports WHERE export_id = ?",
        String(input?.exportId),
      );
      if (!row || typeof input?.userId !== "string") return false;
      return can(await roleIn(c, input.userId), "project.read");
    },

    /** Cron, and the server. Deliver whatever is due in the outbox. */
    drainOutbox: async (c): Promise<void> => {
      if (!c.scheduledFire) requireSystem(c);
      kick(c);
      await outboxIdle(c);
    },
  },
});
