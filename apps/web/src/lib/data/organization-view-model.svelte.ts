import {
  ROLES,
  can,
  organizationKey,
  roleRank,
  type Invitation,
  type Member,
  type OrganizationSnapshot,
  type Permission,
  type ProjectLink,
  type Role,
} from "@example/entities/contracts";
import { EntityViewModel, idFrom } from "./entity-view-model.svelte.js";

/**
 * One organization: members, invitations, the project index, and activity.
 * The same role table the actor enforces decides which controls appear.
 */
export class OrganizationViewModel extends EntityViewModel<"organization"> {
  readonly orgId: string;

  constructor(orgId: string) {
    super({ name: "organization", key: organizationKey(orgId) });
    this.orgId = orgId;
  }

  get members(): Member[] {
    return this.snapshot?.members ?? [];
  }

  get invitations(): Invitation[] {
    return this.snapshot?.invitations ?? [];
  }

  get projects(): ProjectLink[] {
    return this.snapshot?.projects ?? [];
  }

  get myRole(): Role | null {
    const sub = this.principal.current?.sub;
    return this.members.find((member) => member.userId === sub)?.role ?? null;
  }

  can(permission: Permission): boolean {
    return can(this.myRole, permission);
  }

  /** Roles the caller may hand out: below their own, never owner. */
  get grantableRoles(): Role[] {
    const mine = this.myRole;
    if (!mine) return [];
    return ROLES.filter(
      (role) =>
        role !== "owner" &&
        (mine === "owner" || roleRank(role) < roleRank(mine)),
    );
  }

  /** Whether the caller may change or remove this member. Mirrors the actor's checks. */
  canManage(member: Member): boolean {
    const mine = this.myRole;
    if (!mine || member.role === "owner") return false;
    if (member.userId === this.principal.current?.sub) return false;
    if (mine === "owner") return true;
    return can(mine, "member.role") && roleRank(member.role) < roleRank(mine);
  }

  rename(name: string): Promise<OrganizationSnapshot | undefined> {
    return this.run("rename", (actor) => actor.rename({ name }));
  }

  invite(
    userId: string,
    role: Role,
  ): Promise<OrganizationSnapshot | undefined> {
    return this.run("invite", (actor) => actor.invite({ userId, role }));
  }

  revoke(inviteId: string): Promise<OrganizationSnapshot | undefined> {
    return this.run(`revoke:${inviteId}`, (actor) =>
      actor.revokeInvitation(inviteId),
    );
  }

  changeRole(
    userId: string,
    role: Role,
  ): Promise<OrganizationSnapshot | undefined> {
    return this.run(`member:${userId}`, (actor) =>
      actor.changeRole({ userId, role }),
    );
  }

  remove(userId: string): Promise<OrganizationSnapshot | null | undefined> {
    return this.run(`member:${userId}`, (actor) => actor.removeMember(userId));
  }

  transfer(userId: string): Promise<OrganizationSnapshot | undefined> {
    return this.run(`member:${userId}`, (actor) =>
      actor.transferOwnership(userId),
    );
  }

  /** Start a project. Returns its id once the index holds it. */
  async createProject(name: string): Promise<string | null> {
    const projectId = idFrom(name, "project");
    const result = await this.run("create-project", (actor) =>
      actor.createProject({ projectId, name }),
    );
    return result ? projectId : null;
  }

  /** Delete a project and everything in it. Admins only. */
  deleteProject(projectId: string): Promise<OrganizationSnapshot | undefined> {
    return this.run(`project:${projectId}`, (actor) =>
      actor.deleteProject(projectId),
    );
  }
}
