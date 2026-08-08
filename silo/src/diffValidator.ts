import { git } from "./git.js";
import { checkBoundaries } from "./ownership.js";
import type { ChangedPath } from "./ownership.js";
import type { BoundaryViolation, OwnershipConfig, Role } from "./types.js";

/**
 * Stages and commits everything the agent changed in a worktree. Returns false if there was
 * nothing to commit.
 *
 * Uses `--sparse` so this stages changes even outside the worktree's sparse-checkout cone.
 * Without it, `git add -A` silently *drops* out-of-cone changes instead of staging them —
 * which would mean an attempt to write outside the role's owned paths never shows up in the
 * diff at all, and validateWorktreeBoundaries below would have nothing to catch. Boundary
 * enforcement must see the attempt in order to reject and audit it, not have git quietly
 * erase the evidence.
 */
export async function commitAll(worktreePath: string, message: string): Promise<boolean> {
  await git(["add", "-A", "--sparse"], worktreePath);
  const { stdout } = await git(["status", "--porcelain"], worktreePath);
  if (!stdout.trim()) return false;
  await git(["commit", "-m", message], worktreePath);
  return true;
}

/** Parses `git diff --name-status` output into typed changed-path records. */
export function parseNameStatus(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0] ?? "";
    if (statusCode.startsWith("R")) {
      const newPath = parts[2] ?? parts[1];
      if (newPath) changes.push({ path: newPath, operation: "rename" });
    } else if (statusCode === "A") {
      if (parts[1]) changes.push({ path: parts[1], operation: "add" });
    } else if (statusCode === "D") {
      if (parts[1]) changes.push({ path: parts[1], operation: "delete" });
    } else if (parts[1]) {
      changes.push({ path: parts[1], operation: "modify" });
    }
  }
  return changes;
}

/** Returns every path changed on the worktree's branch relative to where it forked from `baseBranch`. */
export async function diffAgainstBase(worktreePath: string, baseBranch: string): Promise<ChangedPath[]> {
  const { stdout } = await git(["diff", "--name-status", `${baseBranch}...HEAD`], worktreePath);
  return parseNameStatus(stdout);
}

/**
 * The enforcement gate described in SILO rule #3: before a specialist's change is accepted,
 * every changed path is checked against the ownership registry. This runs outside the model —
 * it inspects the actual git diff, so it cannot be bypassed by anything the agent says or does
 * inside its own turn.
 */
export async function validateWorktreeBoundaries(
  role: Role,
  worktreePath: string,
  baseBranch: string,
  ownership: OwnershipConfig,
): Promise<{ changedPaths: ChangedPath[]; violations: BoundaryViolation[] }> {
  const changedPaths = await diffAgainstBase(worktreePath, baseBranch);
  const violations = checkBoundaries(role, changedPaths, ownership);
  return { changedPaths, violations };
}
