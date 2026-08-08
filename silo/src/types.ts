/**
 * Shared types for SILO: a role-scoped multi-agent orchestrator built on top of Codex.
 */

/** A specialist role. Extendable — the set of valid roles is defined by config/ownership.yaml. */
export type Role = string;

/** Ownership configuration: which path roots belong to which role. */
export type OwnershipConfig = {
  roles: Record<Role, { owns: string[]; description?: string }>;
};

/** A single project member and the one role they are allowed to invoke. */
export type Member = {
  id: string;
  role: Role;
  displayName?: string;
};

export type MembersConfig = {
  members: Member[];
};

/** Per-role AI provider routing. Each role may use a different vendor/account/model. */
export type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

export type ProvidersConfig = Record<Role, ProviderConfig>;

/** A classified filesystem path: which role (if any) owns it. */
export type PathClassification = {
  path: string;
  owner: Role | "architecture" | "unowned";
};

/** Structured error shape returned when a specialist's change touches a path it does not own. */
export type BoundaryViolation = {
  code: "BOUNDARY_VIOLATION";
  role: Role;
  path: string;
  owner: Role | "architecture" | "unowned";
  operation: "add" | "modify" | "delete" | "rename";
};

/** Request to run one unit of work as a given member/role. */
export type TaskRequest = {
  taskId?: string;
  memberId: string;
  role: Role;
  prompt: string;
};

/** Result of running the full SILO pipeline for one task. */
export type TaskResult = {
  taskId: string;
  role: Role;
  branch: string;
  merged: boolean;
  violations: BoundaryViolation[];
  registryVersion: string;
  finalResponse: string | null;
  changedPaths: string[];
  error?: string;
  /** Whether the merged base branch was pushed to the project's GitHub remote. Absent when there was no project to push to. */
  pushed?: boolean;
  pushError?: string;
};

export class RoleMismatchError extends Error {
  code = "ROLE_MISMATCH" as const;
  constructor(
    public memberId: string,
    public requestedRole: Role,
    public assignedRole: Role,
  ) {
    super(
      `Member '${memberId}' is assigned role '${assignedRole}' and cannot invoke the '${requestedRole}' specialist.`,
    );
    this.name = "RoleMismatchError";
  }
}

export class UnknownMemberError extends Error {
  code = "UNKNOWN_MEMBER" as const;
  constructor(public memberId: string) {
    super(`No member with id '${memberId}' is registered.`);
    this.name = "UnknownMemberError";
  }
}

export class UnknownRoleError extends Error {
  code = "UNKNOWN_ROLE" as const;
  constructor(public role: string) {
    super(`'${role}' is not a role defined in the ownership registry.`);
    this.name = "UnknownRoleError";
  }
}

export class BoundaryViolationError extends Error {
  code = "BOUNDARY_VIOLATION" as const;
  constructor(public violations: BoundaryViolation[]) {
    super(
      `${violations.length} boundary violation(s): ` +
        violations.map((v) => `${v.role} -> ${v.path} (owned by ${v.owner})`).join(", "),
    );
    this.name = "BoundaryViolationError";
  }
}

export class RegistryValidationError extends Error {
  code = "REGISTRY_INVALID" as const;
  constructor(public issues: string[]) {
    super(`Architecture registry failed validation:\n- ${issues.join("\n- ")}`);
    this.name = "RegistryValidationError";
  }
}
