import type { registry } from "@example/api/actors";
import { COUNTER_NAME_PATTERN } from "@example/wire";
import { getActionError, type ReactiveActorHandle } from "@rivetkit/svelte";
import { untrack } from "svelte";
import { actorSocketOptions } from "../actor-socket.js";
import { getRivet } from "../rivet.js";

type CounterActor = ReactiveActorHandle<typeof registry, "counter">;

/**
 * Owns the counter actor socket and the Hono increment call.
 * The page only reads fields and calls these methods.
 */
export class CounterViewModel {
  name = $state("demo");
  count = $state(0);
  hasValue = $state(false);
  snapshotPending = $state(false);
  snapshotError = $state<string | null>(null);
  error = $state<string | null>(null);
  httpPending = $state(false);
  actor = $state.raw<CounterActor | null>(null);

  #rivet = getRivet();
  #socketOptions = actorSocketOptions();
  #unmount: (() => void) | null = null;
  #pullId = 0;

  constructor() {
    $effect(() => {
      const actor = this.actor;
      if (!actor?.isConnected) return;
      const name = this.name;
      untrack(() => {
        void this.#pullCount(actor, name);
      });
    });
  }

  get connStatus(): string {
    return this.actor?.connStatus ?? "idle";
  }

  get connected(): boolean {
    return this.actor?.isConnected ?? false;
  }

  connect(): () => void {
    this.#open(this.name);
    return () => this.#close();
  }

  /** Release this view model's connection; the actor and its state remain in Rivet. */
  disconnect(): void {
    this.#close();
  }

  /** Retry the read without sending a mutation or replacing the socket. */
  async refreshCount(): Promise<void> {
    const actor = this.actor;
    if (actor?.isConnected) await this.#pullCount(actor, this.name);
  }

  /** Reconnect when the counter name changes. */
  useName(name: string): void {
    const next = name.trim().toLowerCase();
    if (!COUNTER_NAME_PATTERN.test(next) || next === this.name) return;
    this.error = null;
    this.#open(next);
  }

  async increment(): Promise<void> {
    const actor = this.actor;
    if (!actor?.isConnected) {
      this.error = "Not connected yet";
      return;
    }

    const next = await actor.increment(1);
    if (this.actor !== actor) return;
    if (next == null) {
      this.error =
        getActionError(actor)?.message ?? "Couldn't increment — try again";
      return;
    }

    this.count = Math.max(this.count, next);
    this.hasValue = true;
    this.error = null;
  }

  /** Same actor, reached through Hono instead of the browser socket. */
  async incrementViaHttp(): Promise<void> {
    if (this.httpPending) return;
    const name = this.name;
    const actor = this.actor;
    this.httpPending = true;
    this.error = null;

    try {
      const response = await fetch(
        `/api/counters/${encodeURIComponent(this.name)}/increment`,
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
      if (this.name !== name || this.actor !== actor) return;
      if (!response.ok || typeof body.count !== "number") {
        this.error = body.error ?? "Couldn't increment through the API";
        return;
      }
      this.count = Math.max(this.count, body.count);
      this.hasValue = true;
    } catch (error) {
      if (this.name !== name || this.actor !== actor) return;
      this.error =
        error instanceof Error
          ? error.message
          : "Couldn't increment through the API";
    } finally {
      this.httpPending = false;
    }
  }

  #open(name: string): void {
    const sameKey = this.name === name;
    this.#close();
    this.error = null;
    this.snapshotError = null;
    this.name = name;
    if (!sameKey) {
      this.count = 0;
      this.hasValue = false;
    }
    const actor = this.#rivet.createReactiveActor({
      name: "counter",
      key: ["counter", name],
      ...this.#socketOptions,
    });
    actor.onEvent("newCount", (count: number) => {
      this.count = Math.max(this.count, count);
      this.hasValue = true;
    });
    this.actor = actor;
    this.#unmount = actor.mount();
  }

  #close(): void {
    this.#pullId++;
    this.snapshotPending = false;
    this.#unmount?.();
    this.actor?.dispose();
    this.#unmount = null;
    this.actor = null;
  }

  async #pullCount(actor: CounterActor, name: string): Promise<void> {
    const pullId = ++this.#pullId;
    this.snapshotPending = true;
    this.snapshotError = null;
    const count = await actor.getCount();
    if (pullId !== this.#pullId || this.name !== name || this.actor !== actor) {
      return;
    }
    this.snapshotPending = false;
    if (count == null) {
      this.snapshotError =
        "Could not load the saved count. Try loading it again.";
      return;
    }
    this.count = Math.max(this.count, count);
    this.hasValue = true;
  }
}
