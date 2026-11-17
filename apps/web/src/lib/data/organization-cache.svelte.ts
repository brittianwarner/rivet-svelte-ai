import { createContext, untrack } from "svelte";
import type { EntityDeps } from "./entity-view-model.svelte.js";
import { OrganizationViewModel } from "./organization-view-model.svelte.js";

/** How long a socket stays open after the last page lets go of it. */
const GRACE_MS = 60_000;

interface Entry {
  model: OrganizationViewModel;
  holds: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  destroy: () => void;
}

/**
 * Organization view models shared by every page of one signed-in person.
 *
 * - Pages `hold` an organization while mounted. When the last one lets go,
 *   the socket stays open for a minute, so going back shows the last
 *   snapshot at once and nothing reconnects.
 * - `warm` opens the socket ahead of a likely visit (hover or focus on a
 *   link), so the first visit is usually ready before the click lands.
 *
 * Projects are not cached: an open project socket counts as "viewing" in
 * the project's presence list.
 */
export class OrganizationCache {
  readonly #deps: EntityDeps;
  readonly #entries = new Map<string, Entry>();

  constructor(deps: EntityDeps) {
    this.#deps = deps;
  }

  /** The view model for this organization, connecting it if needed. */
  get(orgId: string): OrganizationViewModel {
    return this.#entry(orgId).model;
  }

  /** Keep this organization's socket open until the returned release. For `$effect`. */
  hold(orgId: string): () => void {
    const entry = this.#entry(orgId);
    entry.holds++;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--entry.holds > 0) return;
      entry.timer = setTimeout(() => this.#evict(orgId, entry), GRACE_MS);
    };
  }

  /** Open the socket ahead of a likely visit. It closes on its own if unused. */
  warm(orgId: string): void {
    this.hold(orgId)();
  }

  /** Close every socket. For sign-out or a switch to someone else. */
  dispose(): void {
    for (const [orgId, entry] of this.#entries) this.#evict(orgId, entry);
  }

  #entry(orgId: string): Entry {
    const existing = this.#entries.get(orgId);
    if (existing) return existing;
    // Its own effect root: the view model outlives the component that asked
    // first. Untracked, so a caller's effect never subscribes to its setup.
    const entry = untrack((): Entry => {
      let model!: OrganizationViewModel;
      const destroy = $effect.root(() => {
        model = new OrganizationViewModel(orgId, this.#deps);
        return model.connect();
      });
      return { model, holds: 0, timer: undefined, destroy };
    });
    this.#entries.set(orgId, entry);
    // Unheld from the start: it closes on its own unless a page holds it.
    entry.timer = setTimeout(() => this.#evict(orgId, entry), GRACE_MS);
    return entry;
  }

  #evict(orgId: string, entry: Entry): void {
    clearTimeout(entry.timer);
    if (this.#entries.get(orgId) === entry) this.#entries.delete(orgId);
    entry.destroy();
  }
}

export const [getOrganizations, setOrganizations] =
  createContext<OrganizationCache>();

/** The organization of the current `/data/orgs/[orgId]` layout. */
export const [getOrganization, setOrganization] =
  createContext<OrganizationViewModel>();
