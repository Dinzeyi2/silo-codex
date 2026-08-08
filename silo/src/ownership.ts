import path from "node:path";
import type { BoundaryViolation, OwnershipConfig, PathClassification, Role } from "./types.js";

/** The path root that always belongs to the architecture registry, never to a role. */
export const ARCHITECTURE_ROOT = "architecture";

/**
 * Normalizes a repo-relative path for comparison: forward slashes, no leading "./",
 * no leading "/". Rejects attempts to escape the repo root.
 */
export function normalizeRelativePath(rawPath: string): string {
  let normalized = rawPath.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "");
  const resolved = path.posix.normalize(normalized).replace(/\/+$/, "");
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(`Path escapes repository root: '${rawPath}'`);
  }
  return resolved === "." ? "" : resolved;
}

/** True if `candidate` is inside (or equal to) `root` — both must already be normalized. */
function isUnderRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

/** Validates that every role's owned roots are non-overlapping and none collide with "architecture". */
export function validateOwnershipConfig(config: OwnershipConfig): string[] {
  const issues: string[] = [];
  const seen: { role: Role; root: string }[] = [];

  if (!config.roles || Object.keys(config.roles).length === 0) {
    issues.push("ownership config defines no roles");
    return issues;
  }

  for (const [role, def] of Object.entries(config.roles)) {
    if (role === ARCHITECTURE_ROOT) {
      issues.push(
        `role name '${ARCHITECTURE_ROOT}' is reserved for the architecture registry and cannot be a specialist role`,
      );
    }
    if (!def.owns || def.owns.length === 0) {
      issues.push(`role '${role}' owns no paths`);
      continue;
    }
    for (const rawRoot of def.owns) {
      const root = normalizeRelativePath(rawRoot);
      if (!root) {
        issues.push(`role '${role}' declares an empty/root owned path, which would own everything`);
        continue;
      }
      if (root === ARCHITECTURE_ROOT || isUnderRoot(root, ARCHITECTURE_ROOT)) {
        issues.push(`role '${role}' cannot own '${rawRoot}' — that belongs to the architecture registry`);
      }
      for (const other of seen) {
        if (other.role === role) continue;
        if (isUnderRoot(root, other.root) || isUnderRoot(other.root, root)) {
          issues.push(
            `owned path '${rawRoot}' for role '${role}' overlaps with '${other.root}' owned by role '${other.role}'`,
          );
        }
      }
      seen.push({ role, root });
    }
  }
  return issues;
}

/**
 * Classifies a repo-relative path: which role owns it, "architecture" if it belongs
 * to the shared registry, or "unowned" if no role's roots cover it.
 */
export function classifyPath(rawPath: string, config: OwnershipConfig): PathClassification {
  const normalized = normalizeRelativePath(rawPath);

  if (normalized === ARCHITECTURE_ROOT || isUnderRoot(normalized, ARCHITECTURE_ROOT)) {
    return { path: normalized, owner: "architecture" };
  }

  for (const [role, def] of Object.entries(config.roles)) {
    for (const rawRoot of def.owns) {
      const root = normalizeRelativePath(rawRoot);
      if (isUnderRoot(normalized, root)) {
        return { path: normalized, owner: role };
      }
    }
  }

  return { path: normalized, owner: "unowned" };
}

/** Returns true if `role` is allowed to write to `rawPath`. */
export function isPathOwnedByRole(rawPath: string, role: Role, config: OwnershipConfig): boolean {
  return classifyPath(rawPath, config).owner === role;
}

export type ChangedPath = {
  path: string;
  operation: "add" | "modify" | "delete" | "rename";
};

/**
 * Checks a set of changed paths against a role's ownership boundaries.
 * Returns one BoundaryViolation per path that the role does not own — including
 * paths owned by the architecture registry, which no specialist role may write to.
 */
export function checkBoundaries(
  role: Role,
  changedPaths: ChangedPath[],
  config: OwnershipConfig,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const change of changedPaths) {
    const classification = classifyPath(change.path, config);
    if (classification.owner !== role) {
      violations.push({
        code: "BOUNDARY_VIOLATION",
        role,
        path: classification.path,
        owner: classification.owner,
        operation: change.operation,
      });
    }
  }
  return violations;
}

/** Resolves the concrete owned root directories for a role, normalized, plus the shared architecture root. */
export function ownedRootsForRole(role: Role, config: OwnershipConfig): string[] {
  const def = config.roles[role];
  if (!def) return [];
  return def.owns.map((r) => normalizeRelativePath(r));
}
