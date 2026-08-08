import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { RoleMismatchError, UnknownMemberError, UnknownRoleError } from "./types.js";
import type { Member, MembersConfig, OwnershipConfig, Role } from "./types.js";

/** Loads config/members.yaml: the memberId -> assigned-role directory. */
export function loadMembersConfig(filePath: string): MembersConfig {
  if (!existsSync(filePath)) {
    return { members: [] };
  }
  const doc = yaml.load(readFileSync(filePath, "utf8")) as MembersConfig | null;
  return doc && Array.isArray(doc.members) ? doc : { members: [] };
}

export class MemberDirectory {
  private byId = new Map<string, Member>();

  constructor(config: MembersConfig) {
    for (const member of config.members) {
      this.byId.set(member.id, member);
    }
  }

  get(memberId: string): Member | undefined {
    return this.byId.get(memberId);
  }

  all(): Member[] {
    return Array.from(this.byId.values());
  }

  /**
   * Enforces rule #1 of SILO: a project member has exactly one assigned specialist role.
   * When a member submits a task, the requested role must match their assigned role —
   * this is checked by the platform before any model is invoked, not left to the prompt.
   *
   * Throws UnknownMemberError, UnknownRoleError, or RoleMismatchError. Returns the member on success.
   */
  authorize(memberId: string, requestedRole: Role, ownership: OwnershipConfig): Member {
    if (!(requestedRole in ownership.roles)) {
      throw new UnknownRoleError(requestedRole);
    }
    const member = this.byId.get(memberId);
    if (!member) {
      throw new UnknownMemberError(memberId);
    }
    if (member.role !== requestedRole) {
      throw new RoleMismatchError(memberId, requestedRole, member.role);
    }
    return member;
  }
}
