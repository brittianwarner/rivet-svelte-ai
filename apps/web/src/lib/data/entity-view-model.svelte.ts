import type { AppRegistry } from "@example/actors";
import {
  ENTITY_ERRORS,
  LIMITS,
  type AuditEntry,
  type HistoryPage,
  type OrganizationSnapshot,
  type ProjectSnapshot,
  type UserSnapshot,
} from "@example/entities/contracts";
import {
  actorErrorCode,
  actorErrorMessage,
  isActorError,
  type ReactiveActorHandle,
} from "@rivetkit/svelte";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { actorSocketOptions } from "../actor-socket.js";
import { getRivet } from "../rivet.js";
import { getPrincipal } from "./principal.svelte.js";

export type EntityName = "user" | "organization" | "project";
export type UserActor = ReactiveActorHandle<AppRegistry, "user">;
export type OrganizationActor = ReactiveActorHandle<
  AppRegistry,
  "organization"
>;
export type ProjectActor = ReactiveActorHandle<AppRegistry, "project">;
export type ProjectExportActor = ReactiveActorHandle<
  AppRegistry,
  "projectExport"
>;

/** Each actor name with its handle type, written out once. */
interface Handles {
  user: UserActor;
  organization: OrganizationActor;
  project: ProjectActor;
  projectExport: ProjectExportActor;
}
/** Each entity name with its snapshot type. */
interface Snapshots {
  user: UserSnapshot;
  organization: OrganizationSnapshot;
  project: ProjectSnapshot;
}
type HandleName = keyof Handles;
export type EntityActor<N extends HandleName> = Handles[N];
type SnapshotOf<N extends EntityName> = Snapshots[N];

/** What a page should draw. `ready` can still be offline: the last snapshot stays on screen. */
export type EntityView = "loading" | "ready" | "missing" | "denied" | "error";

/** The two calls every entity actor shares. */
interface SharedEntity<T> {
  getSnapshot(): Promise<T>;
  onEvent(name: "changed", handler: (snapshot: T) => void): () => void;
}

/** Organizations and projects keep more history than a snapshot carries. */
interface WithHistory {
  getHistory(before: number): Promise<HistoryPage>;
}

/** Plain-language text for an action or connection failure. */
export function describeError(error: unknown): string {
  if (isActorError(error)) {
    return actorErrorMessage(error) ?? "That did not work. Try again.";
  }
  return "The connection dropped before the change was confirmed. Try again.";
}

function outcomeOf(error: unknown): "missing" | "denied" | null {
  const code = actorErrorCode(error);
  // `not_found` is Rivet's own answer: no actor has this key (or it was deleted).
  if (code === ENTITY_ERRORS.notFound || code === "not_found") return "missing";
  if (
    code === ENTITY_ERRORS.forbidden ||
    code === ENTITY_ERRORS.unauthenticated
  )
    return "denied";
  return null;
}

function isSnapshot(value: unknown): value is { revision: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { revision?: unknown }).revision === "number"
  );
}

export interface EntityOptions<N extends EntityName> {
  name: N;
  key: string[];
  /**
   * Create the actor if no actor has this key. Only for actors a person
   * claims by name, like their own user. Everything else is created by the
   * server, so a guessed key finds nothing instead of starting an actor.
   */
  create?: boolean;
}

/** Newest first, one entry per id. */
function mergeActivity(...lists: AuditEntry[][]): AuditEntry[] {
  const byId = new Map<number, AuditEntry>();
  for (const list of lists) for (const entry of list) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/**
 * One live entity actor: a socket, the newest snapshot, and its actions.
 *
 * - Connects with a fresh principal token on every connect and reconnect.
 * - Pulls a snapshot whenever the socket (re)connects, then follows `changed`.
 * - Keeps the highest revision, so a late reply never undoes a newer event.
 * - Tracks each running action by label, so unrelated buttons stay usable.
 * - Pages older activity on request, for entities that keep history.
 *
 * Construct during component setup (it owns an `$effect`), then call
 * `connect()` from an effect and return its cleanup.
 */
export class EntityViewModel<N extends EntityName> {
  snapshot = $state.raw<SnapshotOf<N> | null>(null);
  error = $state<string | null>(null);
  outcome = $state<"missing" | "denied" | null>(null);
  actor = $state.raw<EntityActor<N> | null>(null);
  readonly busy = new SvelteSet<string>();

  readonly name: N;
  readonly key: string[];
  protected readonly rivet = getRivet();
  protected readonly principal = getPrincipal();
  readonly #create: boolean;
  #socket = actorSocketOptions();
  #pull = 0;
  /** Entries older than the snapshot's, loaded with `showOlderActivity`. */
  #older = $state.raw<AuditEntry[]>([]);
  /** The next page's cursor: `undefined` before the first page, `null` at the start. */
  #olderBefore = $state<number | null | undefined>(undefined);

  constructor(options: EntityOptions<N>) {
    this.name = options.name;
    this.key = options.key;
    this.#create = options.create ?? false;
    $effect(() => {
      const actor = this.actor;
      if (!actor?.isConnected) return;
      untrack(() => void this.refresh());
    });
  }

  get view(): EntityView {
    if (this.outcome) return this.outcome;
    // Refused at connect (removed, or never allowed): the old snapshot goes too.
    const refused = this.actor?.error ? outcomeOf(this.actor.error) : null;
    if (refused) return refused;
    // Deleted while open: reconnects find no actor. Sockets never create
    // these actors, so `not_found` is final, not a blip worth riding out.
    const lastError = this.connected ? null : this.actor?.lastError;
    if (lastError && outcomeOf(lastError) === "missing") return "missing";
    if (this.snapshot) return "ready";
    const error = this.actor?.error ?? this.actor?.lastError;
    if (error) return outcomeOf(error) ?? "error";
    return "loading";
  }

  get connStatus(): string {
    return this.actor?.connStatus ?? "idle";
  }

  get connected(): boolean {
    return this.actor?.isConnected ?? false;
  }

  get connectionError(): Error | null {
    return this.actor?.error ?? null;
  }

  /**
   * Open the socket. Returns the cleanup for `$effect`. Untracked, so nothing
   * read while connecting can make the effect reconnect.
   */
  connect(): () => void {
    return untrack(() => this.#connect());
  }

  #connect(): () => void {
    const actor = this.open(this.name, this.key, { create: this.#create });
    const stops = [
      (actor as unknown as SharedEntity<SnapshotOf<N>>).onEvent(
        "changed",
        (next) => {
          if (this.actor === actor) this.apply(next);
        },
      ),
      ...this.listen(actor),
    ];
    this.actor = actor;
    const release = actor.mount();
    return () => {
      this.#pull++;
      for (const stop of stops) stop();
      release();
      actor.dispose();
      if (this.actor === actor) this.actor = null;
    };
  }

  /** Re-read the snapshot without touching the socket. */
  async refresh(): Promise<void> {
    const actor = this.actor;
    if (!actor) return;
    const pull = ++this.#pull;
    try {
      const next = await this.load(actor);
      if (pull !== this.#pull || this.actor !== actor) return;
      this.outcome = null;
      this.apply(next);
    } catch (error) {
      if (pull !== this.#pull || this.actor !== actor) return;
      const outcome = outcomeOf(error);
      if (outcome) this.outcome = outcome;
      else this.error = describeError(error);
    }
  }

  /** Force a new socket, for example after the network comes back. */
  reconnect(): void {
    this.error = null;
    this.outcome = null;
    this.actor?.reconnect();
  }

  isBusy(label: string): boolean {
    return this.busy.has(label);
  }

  /**
   * Activity, newest first: the snapshot's entries, then any older pages.
   * Organizations and projects only; the user actor keeps no audit.
   */
  get activity(): AuditEntry[] {
    const recent = this.#auditOf(this.snapshot);
    return this.#olderBefore === undefined
      ? recent.toReversed()
      : mergeActivity(recent, this.#older);
  }

  /** Whether older activity exists past what is on screen. */
  get hasOlderActivity(): boolean {
    if (this.#olderBefore !== undefined) return this.#olderBefore !== null;
    // The snapshot holds the newest `LIMITS.audit`. A full window may have more.
    return this.#auditOf(this.snapshot).length >= LIMITS.audit;
  }

  /** Load the next page of older activity. */
  async showOlderActivity(): Promise<void> {
    const oldest = this.activity.at(-1)?.id;
    if (oldest === undefined || this.#olderBefore === null) return;
    const page = await this.run("history", (actor) =>
      (actor as unknown as WithHistory).getHistory(oldest),
    );
    if (!page) return;
    this.#older = mergeActivity(this.#older, page.entries);
    this.#olderBefore = page.before;
  }

  #auditOf(snapshot: SnapshotOf<N> | null): AuditEntry[] {
    return (snapshot as { audit?: AuditEntry[] } | null)?.audit ?? [];
  }

  /**
   * Subscribe to events beyond `changed`. Called once per socket; return the
   * unsubscribe functions. Handlers should check `this.actor === actor`.
   */
  protected listen(_actor: EntityActor<N>): (() => void)[] {
    return [];
  }

  /** Keep the newest revision. Events and replies can arrive in any order. */
  protected apply(next: SnapshotOf<N>): void {
    const previous = this.snapshot;
    if (previous && next.revision < previous.revision) return;
    // Once older pages are on screen, keep entries the snapshot's window
    // slides past, so the list never grows a gap.
    if (this.#olderBefore !== undefined && previous)
      this.#older = mergeActivity(this.#older, this.#auditOf(previous));
    this.snapshot = next;
  }

  /** The first read after each connect. The user actor overrides it to register. */
  protected load(actor: EntityActor<N>): Promise<SnapshotOf<N>> {
    return (actor as unknown as SharedEntity<SnapshotOf<N>>).getSnapshot();
  }

  /**
   * Run one action. A snapshot in the reply is applied at once, so the view
   * never waits for the matching event. Returns `undefined` on failure and
   * puts a plain-language message in `error`.
   */
  protected async run<T>(
    label: string,
    call: (actor: EntityActor<N>) => Promise<T>,
  ): Promise<T | undefined> {
    const actor = this.actor;
    if (!actor || this.busy.has(label)) return undefined;
    this.busy.add(label);
    this.error = null;
    try {
      const result = await call(actor);
      if (this.actor !== actor) return undefined;
      if (isSnapshot(result)) this.apply(result as unknown as SnapshotOf<N>);
      return result;
    } catch (error) {
      if (this.actor === actor) this.error = describeError(error);
      return undefined;
    } finally {
      this.busy.delete(label);
    }
  }

  /**
   * Call one action on another entity without keeping a socket, for example
   * answering an invitation from the inbox. Throws on failure.
   */
  protected async once<M extends HandleName, T>(
    name: M,
    key: string[],
    call: (actor: EntityActor<M>) => Promise<T>,
    options: { create?: boolean } = {},
  ): Promise<T> {
    const actor = this.open(name, key, options);
    const release = actor.mount();
    try {
      return await call(actor);
    } finally {
      release();
      actor.dispose();
    }
  }

  /** Connection params: the app's actor token plus a fresh principal. */
  protected async params(): Promise<{ token?: string; principal: string }> {
    return {
      ...(await this.#socket.getParams()),
      principal: await this.principal.token(),
    };
  }

  protected open<M extends HandleName>(
    name: M,
    key: string[],
    { create = false }: { create?: boolean } = {},
  ): EntityActor<M> {
    // The concrete handle type comes from `Handles`; inferring it from a
    // generic name is too deep for the compiler.
    const options = {
      name: name as HandleName,
      key,
      noCreate: !create,
      getParams: () => this.params(),
      actionDefaults: {
        throwOnError: true,
        timeout: 15_000,
        guardConnection: true,
      },
    };
    return this.rivet.createReactiveActor(
      options as Parameters<typeof this.rivet.createReactiveActor>[0],
    ) as unknown as EntityActor<M>;
  }
}

/** A readable, URL-safe id with a short random tail: `"Launch plan"` → `launch-plan-k3f9`. */
export function idFrom(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const tail = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
  return `${slug || fallback}-${tail}`;
}
