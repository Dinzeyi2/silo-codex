import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { git, branchExists, currentBranch } from "./git.js";
import { withLock } from "./asyncLock.js";
import { ownedRootsForRole } from "./ownership.js";
import type { OwnershipConfig, Role } from "./types.js";

export type WorktreeHandle = {
  role: Role;
  taskId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  integrationRepoPath: string;
};

/** Sanitizes a taskId for safe use as part of a branch name / directory name. */
function sanitizeTaskId(taskId: string): string {
  const cleaned = taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!cleaned) throw new Error("taskId must contain at least one alphanumeric character");
  return cleaned;
}

/**
 * Creates an isolated git worktree + branch for one specialist task, and narrows what's
 * checked out on disk to *only* that role's owned paths plus the shared architecture
 * registry — this is what makes "the model receives only files from its domain" a
 * filesystem-level fact rather than a prompt instruction the model could ignore.
 */
export async function createTaskWorktree(opts: {
  integrationRepoPath: string;
  worktreesRoot: string;
  role: Role;
  taskId: string;
  baseBranch: string;
  ownership: OwnershipConfig;
}): Promise<WorktreeHandle> {
  const { integrationRepoPath, worktreesRoot, role, ownership } = opts;
  const taskId = sanitizeTaskId(opts.taskId);
  const branch = `silo/${role}/${taskId}`;
  const dirName = branch.replace(/\//g, "-");
  const worktreePath = path.join(worktreesRoot, dirName);

  if (!(await branchExists(integrationRepoPath, opts.baseBranch))) {
    // Fall back to whatever is currently checked out so this works against a fresh repo/test fixture.
    const head = await currentBranch(integrationRepoPath);
    if (head !== opts.baseBranch) {
      throw new Error(
        `Base branch '${opts.baseBranch}' does not exist in ${integrationRepoPath} and HEAD is '${head}'.`,
      );
    }
  }

  mkdirSync(worktreesRoot, { recursive: true });
  // Serialized per integration repo: concurrent `git worktree add` calls against the same
  // repo's administrative metadata are not safe to run interleaved.
  await withLock(integrationRepoPath, () =>
    git(["worktree", "add", "-b", branch, worktreePath, opts.baseBranch], integrationRepoPath),
  );

  const ownedRoots = ownedRootsForRole(role, ownership);
  if (ownedRoots.length === 0) {
    throw new Error(`Role '${role}' owns no paths — cannot scope a worktree for it.`);
  }

  await git(["sparse-checkout", "init", "--cone"], worktreePath);
  await git(["sparse-checkout", "set", ...ownedRoots, "architecture"], worktreePath);

  return {
    role,
    taskId,
    branch,
    worktreePath,
    baseBranch: opts.baseBranch,
    integrationRepoPath,
  };
}

/** Removes a task worktree from disk and (optionally) deletes its branch. Safe to call after merge or on rejection. */
export async function removeTaskWorktree(handle: WorktreeHandle, deleteBranch = false): Promise<void> {
  await withLock(handle.integrationRepoPath, async () => {
    try {
      await git(["worktree", "remove", "--force", handle.worktreePath], handle.integrationRepoPath);
    } catch {
      // Worktree metadata may already be gone; make sure the directory is too.
      rmSync(handle.worktreePath, { recursive: true, force: true });
      await git(["worktree", "prune"], handle.integrationRepoPath).catch(() => undefined);
    }
    if (deleteBranch) {
      await git(["branch", "-D", handle.branch], handle.integrationRepoPath).catch(() => undefined);
    }
  });
}
