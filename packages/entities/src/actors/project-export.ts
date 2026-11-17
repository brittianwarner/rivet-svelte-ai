import { actor, event } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { migrations } from "rivetkit/unstable/migrations";
import { workflow } from "rivetkit/workflow";
import {
  authenticate,
  caller,
  createEntityVars,
  forbidden,
  forgetSession,
  trackSession,
  type EntityVars,
} from "../access.ts";
import type { ExportStatus, Task } from "../contracts.ts";
import { parseKey, projectKey } from "../keys.ts";
import { asSystem, unlessMissing, type PeerHost } from "../peers.ts";
import { entityFiles, isSystem } from "../principal.ts";
import type { ExportSource } from "./project.ts";

/**
 * One background job: a CSV export of one project.
 * Key: `["export", orgId, projectId, exportId]`.
 *
 * This is the pattern for durable work that outlives a request. The project
 * records the export and creates this actor; the actor's `run` is a workflow,
 * so each step is recorded and a crash or deploy resumes at the step that was
 * running. The actor's SQLite holds the job record; the CSV itself goes to
 * the file store (the api's bucket in production, `@example/files`), so a
 * large export never bloats the actor. `onRequest` streams it from there, and
 * it is deleted before the actor is.
 *
 *   start   → tell the project the job is running
 *   build   → read the rows from the project, store the CSV (retried)
 *   ready   → report rows and size to the project
 *   sleep   → durable timer until the file expires
 *   expire  → tell the project, delete the file, destroy this actor
 *
 * The project is the source of truth. If it does not know this export (a
 * client created the actor by guessing a key, or the project is gone), the
 * workflow deletes the actor at the first step.
 */

interface JobRow {
  status: ExportStatus;
  rows: number | null;
  bytes: number | null;
  expires_at: number | null;
  error: string | null;
}

export interface ExportJob {
  exportId: string;
  status: ExportStatus;
  rows: number | null;
  bytes: number | null;
  expiresAt: number | null;
  error: string | null;
}

const exportDb = db({
  onMigrate: migrations({
    migrations: [
      {
        version: 1,
        sql: `
          CREATE TABLE job (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            status TEXT NOT NULL DEFAULT 'queued',
            rows INTEGER,
            bytes INTEGER,
            expires_at INTEGER,
            error TEXT
          );
          INSERT INTO job (id) VALUES (1);
          CREATE TABLE files (
            name TEXT PRIMARY KEY,
            content_type TEXT NOT NULL,
            body BLOB NOT NULL
          );
        `,
      },
      // Files moved to the file store.
      { version: 2, sql: "DROP TABLE files;" },
    ],
  }),
});

function idsOf(key: readonly string[]) {
  const [orgId, projectId, exportId] = parseKey(key, "export", 3);
  return { orgId: orgId!, projectId: projectId!, exportId: exportId! };
}

/** What workflow steps and actions both need. */
interface ExportHost extends PeerHost {
  key: readonly string[];
  db: RawAccess;
}

async function readJob(c: ExportHost): Promise<ExportJob> {
  const [row] = await c.db.execute<JobRow & Record<string, unknown>>(
    "SELECT status, rows, bytes, expires_at, error FROM job WHERE id = 1",
  );
  return {
    exportId: idsOf(c.key).exportId,
    status: row?.status ?? "queued",
    rows: row?.rows ?? null,
    bytes: row?.bytes ?? null,
    expiresAt: row?.expires_at ?? null,
    error: row?.error ?? null,
  };
}

function project(c: ExportHost) {
  const { orgId, projectId } = idsOf(c.key);
  return c.client().project.get(projectKey(orgId, projectId), asSystem());
}

/** Tell the project. False when the project no longer knows this export. */
function report(
  c: ExportHost,
  update: {
    status: ExportStatus | "expired";
    rows?: number;
    bytes?: number;
    error?: string;
  },
): Promise<boolean> {
  const { exportId } = idsOf(c.key);
  return unlessMissing(
    () => project(c).applyExport({ exportId, ...update }),
    false,
  );
}

/** One CSV cell. Quotes as needed, and defuses spreadsheet formulas. */
function cell(value: string | number | boolean): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(tasks: Task[]): string {
  const header = ["title", "done", "created_by", "created_at", "comments"];
  const lines = tasks.map((task) =>
    [
      task.title,
      task.done,
      task.createdBy,
      new Date(task.createdAt).toISOString(),
      task.comments,
    ]
      .map(cell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

const CONTENT_TYPE = "text/csv; charset=utf-8";

/** Where this export's bytes live in the file store. */
function fileKey(key: readonly string[]): string {
  const { orgId, projectId, exportId } = idsOf(key);
  return `exports/${orgId}/${projectId}/${exportId}.csv`;
}

/** Delete the file, then the actor. Safe to repeat. */
async function discard(s: ExportHost & { destroy(): void }): Promise<void> {
  await entityFiles().delete(fileKey(s.key));
  s.destroy();
}

export const projectExport = actor({
  db: exportDb,
  createVars: (): EntityVars => createEntityVars(),
  /**
   * The server, or anyone who can read the project right now. The project
   * decides: it knows the export and asks its organization for the role.
   */
  onBeforeConnect: async (c, params) => {
    const { principal } = authenticate(c, params);
    if (isSystem(principal)) return;
    const { exportId } = idsOf(c.key);
    const allowed = await unlessMissing(
      () => project(c).exportAccess({ exportId, userId: principal.sub }),
      false,
    );
    if (!allowed) throw forbidden();
  },
  onConnect: (c, conn) => trackSession(c, conn),
  onDisconnect: (c, conn) => forgetSession(c, conn),
  events: { progress: event<ExportJob>() },

  run: workflow(async (ctx) => {
    const known = await ctx.step({
      name: "start",
      maxRetries: 5,
      run: async (s) => {
        await s.db.execute("UPDATE job SET status = 'running' WHERE id = 1");
        return report(s, { status: "running" });
      },
    });
    if (!known) {
      await ctx.step("discard", async (s) => discard(s));
      return;
    }

    const built = await ctx.tryStep({
      name: "build",
      maxRetries: 3,
      catch: ["exhausted", "critical", "timeout"],
      run: async (s) => {
        const source: ExportSource | null = await project(s).exportSource(
          idsOf(s.key).exportId,
        );
        if (!source) return null;
        const body = new TextEncoder().encode(toCsv(source.tasks));
        // Bytes first, then the record: a retry overwrites the same key.
        await entityFiles().put(fileKey(s.key), body, {
          contentType: CONTENT_TYPE,
        });
        await s.db.execute(
          "UPDATE job SET status = 'ready', rows = ?, bytes = ?, expires_at = ? WHERE id = 1",
          source.tasks.length,
          body.byteLength,
          source.expiresAt,
        );
        s.broadcast("progress", await readJob(s));
        return {
          rows: source.tasks.length,
          bytes: body.byteLength,
          expiresAt: source.expiresAt,
        };
      },
    });

    if (!built.ok || !built.value) {
      const error = built.ok ? "The export was cancelled." : "Export failed.";
      await ctx.step("fail", async (s) => {
        await s.db.execute(
          "UPDATE job SET status = 'failed', error = ? WHERE id = 1",
          error,
        );
        await report(s, { status: "failed", error });
        await discard(s);
      });
      return;
    }

    const { rows, bytes, expiresAt } = built.value;
    await ctx.step({
      name: "ready",
      maxRetries: 10,
      run: async (s) => {
        await report(s, { status: "ready", rows, bytes });
      },
    });

    // A durable timer: survives sleep, crashes, and deploys.
    await ctx.sleepUntil("keep-file", expiresAt);

    await ctx.step("expire", async (s) => {
      await report(s, { status: "expired" });
      await discard(s);
    });
  }),

  /** GET streams the file to a connection `onBeforeConnect` already allowed. */
  onRequest: async (c, request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    caller(c);
    const job = await readJob(c);
    const file =
      job.status === "ready" ? await entityFiles().get(fileKey(c.key)) : null;
    if (!file) return new Response("Not ready.", { status: 404 });
    const { projectId } = idsOf(c.key);
    return new Response(file.body, {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${projectId}-tasks.csv"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },

  actions: {
    /** The job's status. The server calls this to create the actor. */
    getStatus: (c): Promise<ExportJob> => {
      caller(c);
      return readJob(c);
    },
  },
});
