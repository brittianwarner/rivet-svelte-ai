import type { RawAccess } from "rivetkit/db";

/**
 * A transactional outbox: the way one actor tells others about a change.
 *
 * Calling another actor inside a transaction would hold the database while a
 * network call runs, and calling it after commit loses the message if the
 * actor sleeps or crashes in between. So the change and the message commit
 * together: `enqueue(tx, kind, target)` inside `commit`, and `kickOutbox`
 * after it. Delivery runs in the background, retries with backoff, and
 * survives sleep: `onWake` kicks it again, and a named cron job keeps
 * retrying while anything is still waiting.
 *
 * One row per (kind, target). Enqueuing the same pair again bumps its
 * version, so a burst of changes to one user becomes one delivery of the
 * latest view. A delivery that races a newer change leaves the row for the
 * next pass. Handlers must be idempotent: read fresh data, send it whole.
 */

export const OUTBOX_TABLE = `
CREATE TABLE outbox (
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  version INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target)
);
`;

/** The cron job that retries waiting deliveries. */
const RETRY_JOB = "outbox";
/** How often the cron job looks for due rows. Rivet's minimum is 5s. */
const RETRY_INTERVAL_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Rows delivered in parallel per pass. */
const BATCH = 25;
/** Passes per drain, so one drain cannot run forever. */
const MAX_PASSES = 20;

export interface OutboxRow {
  kind: string;
  target: string;
  version: number;
  attempts: number;
}

/** Record a message inside the same transaction as the change it reports. */
export async function enqueue(
  tx: RawAccess,
  kind: string,
  target: string,
): Promise<void> {
  await tx.execute(
    `INSERT INTO outbox (kind, target, version, attempts, due_at) VALUES (?, ?, 1, 0, ?)
     ON CONFLICT (kind, target) DO UPDATE SET version = version + 1, attempts = 0, due_at = excluded.due_at`,
    kind,
    target,
    Date.now(),
  );
}

/** The targets still waiting for one kind of delivery. */
export async function waiting(tx: RawAccess, kind: string): Promise<string[]> {
  const rows = await tx.execute<{ target: string }>(
    "SELECT target FROM outbox WHERE kind = ? ORDER BY target",
    kind,
  );
  return rows.map((row) => row.target);
}

/** Per-wake drain bookkeeping. Keep it in `c.vars.outbox`. */
export interface OutboxVars {
  running: Promise<void> | null;
  /** A kick arrived during a drain: run one more pass after it. */
  again: boolean;
  /** Whether the retry job is known to be set. Unknown after a wake. */
  retrying: boolean | null;
}

export function createOutboxVars(): OutboxVars {
  return { running: null, again: false, retrying: null };
}

/** The slice of an actor context the outbox needs. */
export interface OutboxHost {
  db: RawAccess;
  vars: { outbox: OutboxVars };
  log: { warn: (obj: object, msg?: string) => void };
  keepAwake<T>(promise: Promise<T>): Promise<T>;
  cron: {
    every(job: {
      name: string;
      interval: number;
      action: string;
    }): Promise<unknown>;
    delete(name: string): Promise<boolean>;
  };
}

export interface OutboxHandlers {
  /** Deliver one message. Throw to retry it later. */
  deliver: (row: OutboxRow) => Promise<void>;
  /**
   * Runs after each pass is recorded. Use it to publish when a viewer can see
   * the outcome, like a sync that started or stopped failing.
   */
  settled?: (outcome: {
    delivered: OutboxRow[];
    failed: OutboxRow[];
  }) => Promise<void>;
}

/**
 * Start a drain in the background, or ask the running one for another pass.
 * Never throws; failures stay in the table for the retry job.
 */
export function kickOutbox(c: OutboxHost, handlers: OutboxHandlers): void {
  const state = c.vars.outbox;
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = c
    .keepAwake(drain(c, handlers))
    .catch((error: unknown) =>
      c.log.warn({ error: String(error) }, "outbox drain failed"),
    )
    .finally(() => {
      state.running = null;
    });
}

/** Wait for the running drain, if any. Tests and shutdown use this. */
export function outboxIdle(c: { vars: { outbox: OutboxVars } }): Promise<void> {
  return c.vars.outbox.running ?? Promise.resolve();
}

async function drain(c: OutboxHost, handlers: OutboxHandlers): Promise<void> {
  const state = c.vars.outbox;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    state.again = false;
    const due = (await c.db.execute(
      "SELECT kind, target, version, attempts FROM outbox WHERE due_at <= ? ORDER BY due_at LIMIT ?",
      Date.now(),
      BATCH,
    )) as unknown as OutboxRow[];
    if (due.length === 0 && !state.again) break;
    const results = await Promise.allSettled(due.map(handlers.deliver));
    const delivered = due.filter((_, i) => results[i]?.status === "fulfilled");
    const failed = due.filter((_, i) => results[i]?.status === "rejected");
    for (const [i, result] of results.entries())
      if (result.status === "rejected")
        c.log.warn(
          { kind: due[i]?.kind, error: String(result.reason) },
          "outbox delivery failed; will retry",
        );
    await c.db.transaction(
      async (tx) => {
        for (const row of delivered)
          // A newer version arrived during delivery: keep it for the next pass.
          await tx.execute(
            "DELETE FROM outbox WHERE kind = ? AND target = ? AND version = ?",
            row.kind,
            row.target,
            row.version,
          );
        for (const row of failed)
          await tx.execute(
            "UPDATE outbox SET attempts = attempts + 1, due_at = ? WHERE kind = ? AND target = ? AND version = ?",
            Date.now() + backoff(row.attempts),
            row.kind,
            row.target,
            row.version,
          );
      },
      { name: "outbox.settle" },
    );
    await handlers.settled?.({ delivered, failed });
    // Only failures left: the retry job takes it from here.
    if (delivered.length === 0 && !state.again) break;
  }
  await armRetry(c);
}

function backoff(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
}

/** Keep the retry job set exactly while rows are waiting. */
async function armRetry(c: OutboxHost): Promise<void> {
  const [row] = await c.db.execute<{ n: number }>(
    "SELECT count(*) AS n FROM outbox",
  );
  const pending = (row?.n ?? 0) > 0;
  const state = c.vars.outbox;
  if (pending && state.retrying !== true) {
    await c.cron.every({
      name: RETRY_JOB,
      interval: RETRY_INTERVAL_MS,
      action: "drainOutbox",
    });
    state.retrying = true;
  } else if (!pending && state.retrying !== false) {
    await c.cron.delete(RETRY_JOB);
    state.retrying = false;
  }
}
