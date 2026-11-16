import {
  exportKey,
  projectKey,
  type Comment,
  type CommentPage,
  type ExportLink,
  type ProjectSnapshot,
  type Task,
  type Viewer,
} from "@example/entities/contracts";
import { SvelteMap } from "svelte/reactivity";
import { getRivetClient } from "../rivet.js";
import {
  EntityViewModel,
  describeError,
  type EntityActor,
} from "./entity-view-model.svelte.js";

/** The loaded part of one task's comments, oldest first. */
export interface Thread {
  comments: Comment[];
  /** Cursor for the next older page, or `null` when the start is loaded. */
  before: number | null;
}

/** A finished download, ready to hand to the browser. */
export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

/** Oldest first, one entry per id. */
function mergeComments(...lists: Comment[][]): Comment[] {
  const byId = new Map<number, Comment>();
  for (const list of lists)
    for (const comment of list) byId.set(comment.commentId, comment);
  return [...byId.values()].sort((a, b) => a.commentId - b.commentId);
}

/**
 * One project: tasks, comment threads, who is looking, and exports.
 *
 * - Toggles are optimistic: the checkbox moves at once and the actor's reply
 *   (or its `changed` event) settles it.
 * - Comments are paged. A thread loads when opened, appends live `comment`
 *   events, and catches up after a reconnect.
 * - Presence comes from the `presence` event. It lives only while sockets
 *   are open, so this view re-announces itself on every connect.
 * - Exports run on their own actor. The snapshot lists them; `download`
 *   fetches the file from that actor over HTTP.
 */
export class ProjectViewModel extends EntityViewModel<"project"> {
  readonly orgId: string;
  readonly projectId: string;
  /** taskId → the `done` value the person asked for, until the actor confirms. */
  readonly #intended = new SvelteMap<string, boolean>();
  /** taskId → its loaded comments. Only threads someone opened. */
  readonly #threads = new SvelteMap<string, Thread>();
  #viewers = $state.raw<Viewer[]>([]);
  readonly #client = getRivetClient();

  constructor(orgId: string, projectId: string) {
    super({ name: "project", key: projectKey(orgId, projectId) });
    this.orgId = orgId;
    this.projectId = projectId;
  }

  get tasks(): Task[] {
    return (this.snapshot?.tasks ?? []).map((task) => {
      const done = this.#intended.get(task.taskId);
      return done === undefined ? task : { ...task, done };
    });
  }

  get openCount(): number {
    return this.tasks.filter((task) => !task.done).length;
  }

  /** Who has this project open. Empty while offline: the list would be stale. */
  get viewers(): Viewer[] {
    return this.connected ? this.#viewers : [];
  }

  /** The newest exports, newest first. */
  get exports(): ExportLink[] {
    return this.snapshot?.exports ?? [];
  }

  /** Whether this person already has an export in progress. */
  get exporting(): boolean {
    const sub = this.principal.current?.sub;
    return this.exports.some(
      (link) =>
        link.requestedBy === sub &&
        (link.status === "queued" || link.status === "running"),
    );
  }

  thread(taskId: string): Thread | undefined {
    return this.#threads.get(taskId);
  }

  /** Each connect: read the snapshot, announce presence, catch threads up. */
  protected override async load(
    actor: EntityActor<"project">,
  ): Promise<ProjectSnapshot> {
    const [snapshot, viewers] = await Promise.all([
      actor.getSnapshot() as Promise<ProjectSnapshot>,
      actor.watch() as Promise<Viewer[]>,
    ]);
    if (this.actor === actor) this.#viewers = viewers;
    for (const taskId of this.#threads.keys())
      void this.#loadNewest(actor, taskId);
    return snapshot;
  }

  protected override listen(actor: EntityActor<"project">): (() => void)[] {
    return [
      actor.onEvent("presence", (viewers: Viewer[]) => {
        if (this.actor === actor) this.#viewers = viewers;
      }),
      actor.onEvent("comment", (comment: Comment) => {
        if (this.actor !== actor) return;
        const thread = this.#threads.get(comment.taskId);
        // Closed threads load fresh when opened; the count comes with `changed`.
        if (thread)
          this.#threads.set(comment.taskId, {
            ...thread,
            comments: mergeComments(thread.comments, [comment]),
          });
      }),
    ];
  }

  rename(name: string): Promise<ProjectSnapshot | undefined> {
    return this.run("rename", (actor) => actor.rename(name));
  }

  addTask(title: string): Promise<ProjectSnapshot | undefined> {
    return this.run("add-task", (actor) => actor.addTask(title));
  }

  async toggle(task: Task): Promise<void> {
    const label = `task:${task.taskId}`;
    if (this.isBusy(label)) return;
    this.#intended.set(task.taskId, !task.done);
    await this.run(label, (actor) => actor.toggleTask(task.taskId));
    // Success or failure, the snapshot is the truth again.
    this.#intended.delete(task.taskId);
  }

  async removeTask(task: Task): Promise<boolean> {
    const result = await this.run(`task:${task.taskId}`, (actor) =>
      actor.removeTask(task.taskId),
    );
    if (result) this.#threads.delete(task.taskId);
    return result !== undefined;
  }

  /** Load a thread's newest page the first time it opens. */
  async openThread(taskId: string): Promise<void> {
    const actor = this.actor;
    if (!actor || this.#threads.has(taskId)) return;
    await this.#loadNewest(actor, taskId);
  }

  async loadOlderComments(taskId: string): Promise<void> {
    const thread = this.#threads.get(taskId);
    if (!thread || thread.before === null) return;
    const page = await this.run(`thread:${taskId}`, (actor) =>
      actor.listComments({ taskId, before: thread.before }),
    );
    const current = this.#threads.get(taskId);
    if (!page || !current) return;
    this.#threads.set(taskId, {
      comments: mergeComments(page.comments, current.comments),
      before: page.before,
    });
  }

  /** Post a comment. Resolves true once the actor stored it. */
  async addComment(taskId: string, body: string): Promise<boolean> {
    const comment = await this.run(`comment:${taskId}`, (actor) =>
      actor.addComment({ taskId, body }),
    );
    if (!comment) return false;
    const thread = this.#threads.get(taskId);
    if (thread)
      this.#threads.set(taskId, {
        ...thread,
        comments: mergeComments(thread.comments, [comment]),
      });
    return true;
  }

  /** Start a CSV export. The list shows it at once; the status updates live. */
  startExport(): Promise<ProjectSnapshot | undefined> {
    return this.run("export", (actor) => actor.startExport());
  }

  /**
   * Fetch a finished export. The export actor checks access itself, so this
   * is a plain HTTP request with the same principal the socket uses.
   */
  async download(link: ExportLink): Promise<DownloadedFile | null> {
    const label = `download:${link.exportId}`;
    if (this.busy.has(label)) return null;
    this.busy.add(label);
    this.error = null;
    try {
      const handle = this.#client.projectExport.get(
        exportKey(this.orgId, this.projectId, link.exportId),
        { params: await this.params() },
      );
      const response = await handle.fetch("/");
      if (!response.ok) {
        this.error =
          response.status === 404
            ? "That export has expired. Start a new one."
            : "The download did not start. Try again.";
        return null;
      }
      return {
        blob: await response.blob(),
        filename: `${this.projectId}-tasks.csv`,
      };
    } catch (error) {
      this.error = describeError(error);
      return null;
    } finally {
      this.busy.delete(label);
    }
  }

  /**
   * Fetch a thread's newest page and merge it in. If more comments arrived
   * while offline than one page holds, the older loaded ones are dropped so
   * the thread never shows a gap.
   */
  async #loadNewest(
    actor: EntityActor<"project">,
    taskId: string,
  ): Promise<void> {
    let page: CommentPage;
    try {
      page = (await actor.listComments({ taskId })) as CommentPage;
    } catch (error) {
      if (this.actor === actor) this.error = describeError(error);
      return;
    }
    if (this.actor !== actor) return;
    const current = this.#threads.get(taskId);
    // Ids are shared by every task, so only overlap proves there is no gap.
    const newestLoaded = current?.comments.at(-1)?.commentId ?? 0;
    const oldestFetched = page.comments[0]?.commentId ?? 0;
    const gap = page.before !== null && oldestFetched > newestLoaded;
    this.#threads.set(
      taskId,
      !current || gap
        ? page
        : {
            comments: mergeComments(current.comments, page.comments),
            before: current.before,
          },
    );
  }
}
