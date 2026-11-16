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
import { isSystem } from "../principal.ts";
import type { ExportSource } from "./project.ts";

/**
 * One background job: a CSV export of one project.
 * Key: `["export", orgId, projectId, exportId]`.
 *
 * This is the pattern for durable work that outlives a request. The project
 * records the export and creates this actor; the actor's `run` is a workflow,
 * so each step is recorded and a crash or deploy resumes at the step that was
 * running. The file lives in the actor's own SQLite database, is served by
 * `onRequest`, and is deleted with the actor when it expires.
 *
 *   start   → tell the project the job is running
 *   build   → read the rows from the project, write the CSV (retried)
 *   ready   → report rows and size to the project
 *   sleep   → durable timer until the file expires
 *   expire  → tell the project, then destroy this actor and its file
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

const FILE = "export.csv";

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
      await ctx.step("discard", async (s) => s.destroy());
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
        await s.db.transaction(
          async (tx) => {
            await tx.execute(
              "INSERT OR REPLACE INTO files (name, content_type, body) VALUES (?, 'text/csv; charset=utf-8', ?)",
              FILE,
              body,
            );
            await tx.execute(
              "UPDATE job SET status = 'ready', rows = ?, bytes = ?, expires_at = ? WHERE id = 1",
              source.tasks.length,
              body.byteLength,
              source.expiresAt,
            );
          },
          { name: "export.write" },
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
        s.destroy();
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
      s.destroy();
    });
  }),

  /** GET serves the file to a connection `onBeforeConnect` already allowed. */
  onRequest: async (c, request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    caller(c);
    const [file] = await c.db.execute<{
      content_type: string;
      body: Uint8Array;
    }>("SELECT content_type, body FROM files WHERE name = ?", FILE);
    if (!file) return new Response("Not ready.", { status: 404 });
    const { projectId } = idsOf(c.key);
    return new Response(new Uint8Array(file.body), {
      headers: {
        "content-type": file.content_type,
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
