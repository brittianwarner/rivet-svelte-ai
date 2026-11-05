import type { registry } from "@example/api/actors";
import {
  COUNTER_NAME_PATTERN,
  SESSION_ACTOR_LIMIT,
  SESSION_ID_PATTERN,
  sessionCounterKey,
  type SessionSnapshot,
} from "@example/wire";
import { getActionError, type ReactiveActorHandle } from "@rivetkit/svelte";
import { untrack } from "svelte";
import { actorSocketOptions } from "../actor-socket.js";
import { getRivet } from "../rivet.js";
import { CounterViewModel } from "./counter-view-model.svelte.js";

type SessionActor = ReactiveActorHandle<typeof registry, "session">;
export interface SessionCounter {
  key: string;
  label: string;
  model: CounterViewModel;
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
  #pool = Array.from(
    { length: SESSION_ACTOR_LIMIT },
    () => new CounterViewModel(),
  );
  #members = new Map<string, SessionCounter>();
  #disconnected = new Set<string>();
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
  get connectedActors(): number {
    return new Set(
      this.actors
        .filter((entry) => entry.model.connected)
        .map((entry) => entry.key),
    ).size;
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
  disconnect(key: string): void {
    const entry = this.#members.get(key);
    if (!entry) return;
    this.#disconnected.add(key);
    entry.model.disconnect();
  }
  reconnect(key: string): void {
    const entry = this.#members.get(key);
    if (!entry || !this.#active) return;
    this.#disconnected.delete(key);
    this.#open(entry);
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
      this.reconnect(normalized);
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
  #open(entry: SessionCounter): void {
    if (entry.model.actor) return;
    if (entry.model.name === entry.key) entry.model.connect();
    else entry.model.useName(entry.key);
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
    for (const [key, entry] of this.#members) {
      if (!snapshot.actors.some((record) => record.key === key)) {
        entry.model.disconnect();
        this.#members.delete(key);
        this.#disconnected.delete(key);
      }
    }
    for (const record of snapshot.actors) {
      let entry = this.#members.get(record.key);
      if (!entry) {
        const used = new Set(
          [...this.#members.values()].map((member) => member.model),
        );
        const model = this.#pool.find((candidate) => !used.has(candidate));
        if (!model) {
          this.error = "The session actor limit was exceeded.";
          return;
        }
        entry = { ...record, model };
        this.#members.set(record.key, entry);
      } else entry.label = record.label;
      if (!this.#disconnected.has(record.key)) this.#open(entry);
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
      if (operation.kind !== "remove" && this.#members.has(key)) {
        this.selectedKey = key;
        this.reconnect(key);
      }
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
    for (const model of this.#pool) model.disconnect();
  }
}
