/**
 * A flag that turns on only once `source()` has stayed true for `ms`, and
 * turns off at once.
 *
 * Use it for pending looks: a reply that lands within a round trip changes
 * nothing on screen but the value, and only a slow one shows "waiting".
 * Guard re-entry with the source itself, not with this flag.
 *
 * Call during component setup (it owns an `$effect`).
 */
export function lagging(
  source: () => boolean,
  ms = 300,
): { readonly current: boolean } {
  let current = $state(false);
  $effect(() => {
    if (!source()) {
      current = false;
      return;
    }
    const timer = setTimeout(() => (current = true), ms);
    return () => clearTimeout(timer);
  });
  return {
    get current() {
      return current;
    },
  };
}
