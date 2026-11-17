import {
  organizationKey,
  userKey,
  type InvitationNotice,
  type OrganizationSnapshot,
  type UserSnapshot,
} from "@example/entities/contracts";
import { createContext } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import {
  EntityViewModel,
  describeError,
  idFrom,
  type EntityActor,
  type EntityDeps,
} from "./entity-view-model.svelte.js";

/**
 * The signed-in person's own actor: profile, preferences, and the mirror of
 * their organizations and invitations. One socket draws the whole sidebar.
 */
export class UserViewModel extends EntityViewModel<"user"> {
  /** Organizations this person belonged to while this page was open. */
  readonly #joined = new SvelteSet<string>();

  constructor(userId: string, deps: EntityDeps) {
    // Each person's actor starts the first time they sign in.
    super({ name: "user", key: userKey(userId), create: true, deps });
  }

  protected override apply(next: UserSnapshot): void {
    super.apply(next);
    for (const link of this.snapshot?.organizations ?? [])
      this.#joined.add(link.orgId);
  }

  /**
   * True once this person was a member and the mirror dropped the org. A
   * removed member's org socket stops receiving changes, but their own user
   * actor still hears about it, so pages close from here.
   */
  lostAccess(orgId: string): boolean {
    return (
      this.#joined.has(orgId) &&
      !this.organizations.some((link) => link.orgId === orgId)
    );
  }

  get organizations(): UserSnapshot["organizations"] {
    return this.snapshot?.organizations ?? [];
  }

  get inbox(): InvitationNotice[] {
    return this.snapshot?.inbox ?? [];
  }

  get theme(): "light" | "dark" {
    return this.snapshot?.preferences.theme ?? "light";
  }

  /** Registration is idempotent, so it doubles as the first read. */
  protected override load(actor: EntityActor<"user">): Promise<UserSnapshot> {
    return actor.register() as Promise<UserSnapshot>;
  }

  rename(name: string): Promise<UserSnapshot | undefined> {
    return this.run("rename", (actor) => actor.updateProfile({ name }));
  }

  setTheme(theme: "light" | "dark"): Promise<UserSnapshot | undefined> {
    return this.run("theme", (actor) => actor.setTheme(theme));
  }

  /** Claim a new organization. Returns its id, or null with `error` set. */
  async createOrganization(name: string): Promise<string | null> {
    const label = "create-org";
    const done = this.begin(label);
    if (!done) return null;
    this.error = null;
    const orgId = idFrom(name, "org");
    try {
      // Claiming a new id is the one place a browser creates an organization.
      await this.once(
        "organization",
        organizationKey(orgId),
        (org) => org.create({ name }),
        { create: true },
      );
      return orgId;
    } catch (error) {
      this.error = describeError(error);
      return null;
    } finally {
      done();
    }
  }

  /** Answer an invitation. The organization updates this mirror on its own. */
  async respond(
    notice: InvitationNotice,
    accept: boolean,
  ): Promise<OrganizationSnapshot | null | undefined> {
    const label = `invite:${notice.inviteId}`;
    const done = this.begin(label);
    if (!done) return undefined;
    this.error = null;
    try {
      return await this.once(
        "organization",
        organizationKey(notice.orgId),
        (org) => org.respond({ inviteId: notice.inviteId, accept }),
      );
    } catch (error) {
      this.error = describeError(error);
      return undefined;
    } finally {
      done();
    }
  }
}

export const [getUser, setUser] = createContext<UserViewModel>();
