import { createSubscriber } from "svelte/reactivity";

/**
 * A shared "now" that ticks every 30 seconds, only while something on screen
 * reads it. Relative times stay fresh without one timer per row.
 */
class Clock {
  #subscribe = createSubscriber((update) => {
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  });

  get now(): number {
    this.#subscribe();
    return Date.now();
  }
}

export const clock = new Clock();

/** "just now", "5m ago", "3h ago", "2d ago", or a date. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** "in 45m", "in 6h", "in 3d", or "expired". For invitations and exports. */
export function until(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
