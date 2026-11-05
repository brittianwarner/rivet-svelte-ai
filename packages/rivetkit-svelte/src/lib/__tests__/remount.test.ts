import "./runes-shim.js";
import { afterEach, expect, test, vi } from "vitest";
import { createRivetKitWithClient } from "../rivetkit.svelte.js";

function harness() {
  const connections: ReturnType<typeof connection>[] = [];
  function connection() {
    const listeners = new Set<(value: number) => void>();
    return {
      onStatusChange(callback: (status: "connected") => void) {
        callback("connected");
        return () => {};
      },
      onError: () => () => {},
      on(_event: string, listener: (value: number) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (value: number) => listeners.forEach((listener) => listener(value)),
      dispose: vi.fn(),
    };
  }
  const connect = vi.fn(() => {
    const current = connection();
    connections.push(current);
    return current;
  });
  const rivet = createRivetKitWithClient({
    getOrCreate: () => ({ connect }),
  } as never);
  const actor = rivet.createReactiveActor({
    name: "counter" as never,
    key: ["remount"],
  });
  return { actor, connect, connections };
}

afterEach(() => vi.useRealTimers());

test("remount after bridge eviction opens a fresh connection and restores events", async () => {
  vi.useFakeTimers();
  const { actor, connect, connections } = harness();
  const listener = vi.fn();
  actor.onEvent("newCount", listener);
  const release = actor.mount();
  connections[0]!.emit(1);
  expect(listener).toHaveBeenLastCalledWith(1);
  release();
  expect(actor.connStatus).toBe("idle");
  await vi.advanceTimersByTimeAsync(1);
  expect(connections[0]!.dispose).toHaveBeenCalledTimes(1);

  actor.mount();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(actor.connStatus).toBe("connected");
  connections[0]!.emit(2);
  connections[1]!.emit(3);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenLastCalledWith(3);
  actor.dispose();
  await vi.advanceTimersByTimeAsync(1);
});

test("multiple mounts retain the connection until the last release and same-turn remount reuses it", async () => {
  vi.useFakeTimers();
  const { actor, connect, connections } = harness();
  const first = actor.mount();
  const second = actor.mount();
  first();
  first();
  await vi.advanceTimersByTimeAsync(1);
  expect(actor.connStatus).toBe("connected");
  expect(connections[0]!.dispose).not.toHaveBeenCalled();
  second();
  actor.mount();
  await vi.advanceTimersByTimeAsync(1);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(actor.connStatus).toBe("connected");
  actor.dispose();
  await vi.advanceTimersByTimeAsync(1);
  expect(connections[0]!.dispose).toHaveBeenCalledTimes(1);
});
