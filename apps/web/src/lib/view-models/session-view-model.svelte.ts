import type { AppRegistry } from "@example/actors";
import {
  COUNTER_NAME_PATTERN,
  SESSION_ACTOR_LIMIT,
  SESSION_ID_PATTERN,
  sessionCounterKey,
  type SessionSnapshot,
  type SessionValue,
} from "@example/wire";
import { getActionError, type ReactiveActorHandle } from "@rivetkit/svelte";
import { untrack } from "svelte";
import { actorSocketOptions } from "../actor-socket.js";
import { getRivet } from "../rivet.js";

type SessionActor = ReactiveActorHandle<AppRegistry, "session">;

/** One saved counter, projected from the session actor. It does not open a socket. */
export class SessionCounter {
  readonly key: string;
  label = $state("");
  count = $state(0);
  hasValue = $state(false);
  snapshotPending = $state(true);
  snapshotError = $state<string | null>(null);
  error = $state<string | null>(null);
  httpPending = $state(false);

  constructor(key: string, label: string) {
    this.key = key;
    this.label = label;
  }
}
type RetryOperation =
  | { kind: "create"; requestId: string }
  | { kind: "attach"; key: string; label?: string }
  | { kind: "remove"; key: string };
const STORAGE_KEY = "rivet-svelte-ai.visitorId";

/** Persist only an opaque identity. Rivet owns the registry and actor state. */
function visitorIdentity(): { id: string; temporary: boolean } {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && SESSION_ID_PATTERN.test(existing))
      return { id: existing, temporary: false };
  } catch {
    /* Storage denial still permits an ephemeral playground. */
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(STORAGE_KEY, id);
    return { id, temporary: false };
  } catch {
    return { id, temporary: true };
  }
}

export class SessionViewModel {
  id = $state("");
  temporary = $state(false);
  actors = $state.raw<SessionCounter[]>([]);
  selectedKey = $state("");
  revision = $state(-1);
  loading = $state(true);
  pending = $state(false);
  error = $state<string | null>(null);
  actor = $state.raw<SessionActor | null>(null);

  #rivet = getRivet();
  #options = actorSocketOptions();
  #members = new Map<string, SessionCounter>();
  #pendingValues = new Map<string, number>();
  #release: (() => void) | undefined;
  #active = false;
  #generation = 0;
  #restoreVersion = 0;
  #retry: RetryOperation | undefined;
  #connectionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    $effect(() => {
      const actor = this.actor;
      if (!actor?.isConnected) return;
      untrack(() => {
        void this.#restore(actor);
      });
    });
  }
  get connected(): boolean {
    return this.actor?.isConnected ?? false;
  }
  get canMutate(): boolean {
    return this.connected && !this.loading && !this.pending;
  }
  get connectionError(): string | null {
    if (this.connected || !this.actor) return null;
    const error = this.actor.error ?? this.actor.lastError;
    if (error) return `Session connection unavailable: ${error.message}`;
    const status: string = this.actor.connStatus;
    return ["disconnected", "reconnecting", "error"].includes(status)
      ? "The session connection was lost. Rivet is reconnecting; you can also retry now."
      : null;
  }
  /** The page opens one actor: this session. */
  get connectedActors(): number {
    return this.connected ? 1 : 0;
  }
  connect(): () => void {
    if (this.#active) return () => this.#close();
    this.#active = true;
    const generation = ++this.#generation;
    void this.#start(generation);
    return () => this.#close();
  }
  async #start(generation: number): Promise<void> {
    if (!this.id) {
      const identity = () =>
        this.#active && generation === this.#generation
          ? visitorIdentity()
          : null;
      let result: ReturnType<typeof visitorIdentity> | null;
      try {
        result = navigator.locks?.request
          ? await navigator.locks.request(STORAGE_KEY, identity)
          : identity();
      } catch {
        result = identity();
      }
      if (!result || !this.#active || generation !== this.#generation) return;
      this.id = result.id;
      this.temporary = result.temporary;
    }
    if (this.#active && generation === this.#generation) this.#mountSession();
  }
  #mountSession(): void {
    clearTimeout(this.#connectionTimer);
    this.#generation++;
    this.#restoreVersion++;
    this.#release?.();
    this.actor?.dispose();
    this.actor = null;
    this.loading = true;
    this.pending = false;
    this.error = null;
    const actor = this.#rivet.createReactiveActor({
      name: "session",
      key: [this.id],
      ...this.#options,
      actionDefaults: { timeout: 15_000, guardConnection: true },
    });
    actor.onEvent("changed", (snapshot) => {
      if (this.#active && this.actor === actor) this.#apply(snapshot);
    });
    actor.onEvent("value", (value) => {
      if (this.#active && this.actor === actor) this.#applyValue(value);
    });
    this.actor = actor;
    this.#release = actor.mount();
    this.#connectionTimer = setTimeout(() => {
      if (this.#active && this.actor === actor && !actor.isConnected) {
        this.loading = false;
        this.error =
          "Could not connect to your session. Check that the API and Rivet are running, then retry.";
      }
    }, 15_000);
  }
  select(key: string): void {
    if (this.#members.has(key)) this.selectedKey = key;
  }
  async increment(key: string): Promise<void> {
    const entry = this.#members.get(key);
    const actor = this.actor;
    if (!entry) return;
    if (!actor?.isConnected) {
      entry.error = "Not connected yet";
      return;
    }
    const next = await actor.increment(key);
    if (this.actor !== actor || this.#members.get(key) !== entry) return;
    if (next == null) {
      entry.error =
        getActionError(actor)?.message ?? "Couldn't increment — try again";
      return;
    }
    entry.count = Math.max(entry.count, next);
    entry.hasValue = true;
    entry.snapshotPending = false;
    entry.error = null;
  }
  /** Same counter, reached through the API instead of the session action. */
  async incrementViaHttp(key: string): Promise<void> {
    const entry = this.#members.get(key);
    if (!entry || entry.httpPending) return;
    entry.httpPending = true;
    entry.error = null;
    try {
      const response = await fetch(
        `/api/counters/${encodeURIComponent(key)}/increment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ by: 1 }),
        },
      );
      const body = (await response.json()) as {
        count?: number;
        error?: string;
      };
      if (this.#members.get(key) !== entry) return;
      if (!response.ok || typeof body.count !== "number") {
        entry.error = body.error ?? "Couldn't increment through the API";
        return;
      }
      entry.count = Math.max(entry.count, body.count);
      entry.hasValue = true;
      entry.snapshotPending = false;
    } catch (error) {
      if (this.#members.get(key) !== entry) return;
      entry.error =
        error instanceof Error
          ? error.message
          : "Couldn't increment through the API";
    } finally {
      if (this.#members.get(key) === entry) entry.httpPending = false;
    }
  }
  async refreshCount(key: string): Promise<void> {
    const entry = this.#members.get(key);
    const actor = this.actor;
    if (!entry || !actor?.isConnected) return;
    entry.snapshotPending = true;
    entry.snapshotError = null;
    const values = await actor.getValues();
    if (this.actor !== actor || this.#members.get(key) !== entry) return;
    entry.snapshotPending = false;
    const found = values?.find((value) => value.key === key);
    if (!found || !Number.isSafeInteger(found.count)) {
      entry.snapshotError =
        getActionError(actor)?.message ??
        "Could not load the saved count. Try loading it again.";
      return;
    }
    entry.count = Math.max(entry.count, found.count);
    entry.hasValue = true;
  }
  async createCounter(): Promise<void> {
    if (!this.canMutate || this.actors.length >= SESSION_ACTOR_LIMIT) return;
    const operation: RetryOperation =
      this.#retry?.kind === "create"
        ? this.#retry
        : { kind: "create", requestId: crypto.randomUUID() };
    await this.#mutate(operation);
  }
  async removeCounter(key: string): Promise<void> {
    if (!this.canMutate) return;
    await this.#mutate({ kind: "remove", key });
  }
  async attachCounter(key: string, label?: string): Promise<void> {
    if (!this.canMutate) return;
    const normalized = key.trim().toLowerCase();
    if (!COUNTER_NAME_PATTERN.test(normalized)) {
      this.error =
        "Use 1–64 letters, numbers, or hyphens, starting with a letter or number.";
      return;
    }
    const existing = this.#members.get(normalized);
    if (existing) {
      this.select(normalized);
      this.error = null;
      return;
    }
    await this.#mutate({ kind: "attach", key: normalized, label });
  }
  async retry(): Promise<void> {
    const actor = this.actor;
    if (this.pending) return;
    if (!actor?.isConnected) {
      if (this.#active) this.#mountSession();
      return;
    }
    if (this.#retry) await this.#mutate(this.#retry);
    else await this.#restore(actor);
  }
  #applyValue(value: SessionValue): void {
    if (
      !value ||
      typeof value.key !== "string" ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    )
      return;
    const entry = this.#members.get(value.key);
    if (!entry) {
      const previous = this.#pendingValues.get(value.key);
      this.#pendingValues.set(
        value.key,
        previous === undefined ? value.count : Math.max(previous, value.count),
      );
      return;
    }
    entry.count = Math.max(entry.count, value.count);
    entry.hasValue = true;
    entry.snapshotPending = false;
    entry.snapshotError = null;
  }
  #apply(snapshot: SessionSnapshot): void {
    if (!this.#active) return;
    if (!snapshot || typeof snapshot !== "object") {
      this.error =
        "The session returned an invalid actor registry. Retry the session.";
      return;
    }
    if (snapshot.revision < this.revision) return;
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Array.isArray(snapshot.actors) ||
      snapshot.actors.length > SESSION_ACTOR_LIMIT ||
      snapshot.actors.some(
        (record) =>
          typeof record?.key !== "string" ||
          !COUNTER_NAME_PATTERN.test(record.key) ||
          typeof record.label !== "string",
      ) ||
      new Set(snapshot.actors.map((record) => record.key)).size !==
        snapshot.actors.length
    ) {
      this.error =
        "The session returned an invalid actor registry. Retry the session.";
      return;
    }
    for (const [key] of this.#members) {
      if (!snapshot.actors.some((record) => record.key === key)) {
        this.#members.delete(key);
        this.#pendingValues.delete(key);
      }
    }
    for (const record of snapshot.actors) {
      let entry = this.#members.get(record.key);
      if (!entry) {
        if (this.#members.size >= SESSION_ACTOR_LIMIT) {
          this.error = "The session actor limit was exceeded.";
          return;
        }
        entry = new SessionCounter(record.key, record.label);
        const pending = this.#pendingValues.get(record.key);
        if (pending !== undefined) {
          entry.count = pending;
          entry.hasValue = true;
          entry.snapshotPending = false;
          this.#pendingValues.delete(record.key);
        }
        this.#members.set(record.key, entry);
      } else entry.label = record.label;
    }
    this.revision = snapshot.revision;
    this.actors = snapshot.actors.map((record) =>
      this.#members.get(record.key)!,
    );
    if (!this.actors.some((entry) => entry.key === this.selectedKey))
      this.selectedKey = this.actors[0]?.key ?? "";
  }
  async #restore(actor: SessionActor): Promise<void> {
    const version = ++this.#restoreVersion;
    const generation = this.#generation;
    this.loading = true;
    this.error = null;
    try {
      const snapshot = await actor.ensureStarter();
      if (
        !this.#active ||
        this.actor !== actor ||
        generation !== this.#generation ||
        version !== this.#restoreVersion
      )
        return;
      if (!snapshot)
        throw new Error(
          getActionError(actor)?.message ?? "Could not restore your session.",
        );
      this.#apply(snapshot);
      const values = await actor.getValues();
      if (
        !this.#active ||
        this.actor !== actor ||
        generation !== this.#generation ||
        version !== this.#restoreVersion
      )
        return;
      if (!values)
        throw new Error(
          getActionError(actor)?.message ?? "Could not load saved counts.",
        );
      for (const value of values) this.#applyValue(value);
      for (const entry of this.actors) {
        if (entry.hasValue || values.some((value) => value.key === entry.key))
          continue;
        entry.snapshotPending = false;
        entry.snapshotError =
          "Could not load the saved count. Try loading it again.";
      }
    } catch (error) {
      if (
        this.#active &&
        this.actor === actor &&
        generation === this.#generation &&
        version === this.#restoreVersion
      )
        this.error =
          error instanceof Error
            ? error.message
            : "Could not restore your session. Please retry.";
    } finally {
      if (
        this.#active &&
        this.actor === actor &&
        generation === this.#generation &&
        version === this.#restoreVersion
      )
        this.loading = false;
    }
  }
  async #mutate(operation: RetryOperation): Promise<void> {
    const actor = this.actor;
    if (!actor?.isConnected || this.pending) return;
    const generation = this.#generation;
    this.pending = true;
    this.error = null;
    this.#retry = operation;
    try {
      const snapshot =
        operation.kind === "create"
          ? await actor.createCounter(operation.requestId)
          : operation.kind === "remove"
            ? await actor.removeCounter(operation.key)
            : await actor.attachCounter(operation.key, operation.label);
      if (
        !this.#active ||
        this.actor !== actor ||
        generation !== this.#generation
      )
        return;
      if (!snapshot)
        throw new Error(
          getActionError(actor)?.message ?? "Could not update your session.",
        );
      this.#apply(snapshot);
      const key =
        operation.kind === "create"
          ? sessionCounterKey(this.id, operation.requestId)
          : operation.key;
      if (operation.kind !== "remove" && this.#members.has(key))
        this.selectedKey = key;
      this.#retry = undefined;
    } catch (error) {
      if (
        this.#active &&
        this.actor === actor &&
        generation === this.#generation
      )
        this.error =
          error instanceof Error
            ? error.message
            : "Could not update your session. Please retry.";
    } finally {
      if (
        this.#active &&
        this.actor === actor &&
        generation === this.#generation
      )
        this.pending = false;
    }
  }
  #close(): void {
    if (!this.#active) return;
    this.#active = false;
    clearTimeout(this.#connectionTimer);
    this.#generation++;
    this.#restoreVersion++;
    this.#release?.();
    this.actor?.dispose();
    this.actor = null;
  }
}
