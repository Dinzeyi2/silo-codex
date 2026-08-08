import { git } from "./git.js";
import { withLock } from "./asyncLock.js";
import { commitAll, validateWorktreeBoundaries } from "./diffValidator.js";
import type { WorktreeHandle } from "./worktreeManager.js";
import type { BoundaryViolation, OwnershipConfig, Role } from "./types.js";

export type IntegrationResult = {
  committed: boolean;
  merged: boolean;
  violations: BoundaryViolation[];
  changedPaths: string[];
};

/**
 * Merges a specialist branch into the integration branch (`git merge --no-ff`), after
 * committing the worktree's changes and validating them against the ownership registry.
 * A branch is convenient for isolating work, but — per SILO's design — it is not itself the
 * security boundary; the boundary check below is what's actually authoritative, and it runs
 * again here, immediately before merge, even if it already ran once earlier in the pipeline.
 */
export async function commitValidateAndMerge(
  handle: WorktreeHandle,
  role: Role,
  ownership: OwnershipConfig,
  commitMessage: string,
): Promise<IntegrationResult> {
  const committed = await commitAll(handle.worktreePath, commitMessage);

  const { changedPaths, violations } = await validateWorktreeBoundaries(
    role,
    handle.worktreePath,
    handle.baseBranch,
    ownership,
  );

  if (violations.length > 0) {
    return { committed, merged: false, violations, changedPaths: changedPaths.map((c) => c.path) };
  }

  if (!committed || changedPaths.length === 0) {
    return { committed, merged: false, violations: [], changedPaths: [] };
  }

  // Serialized per integration repo: concurrent tasks merging at once would otherwise race on
  // `git checkout` + `git merge` against the same shared working directory.
  await withLock(handle.integrationRepoPath, () =>
    mergeBranchIntoIntegration(handle.integrationRepoPath, handle.branch, handle.baseBranch, commitMessage),
  );

  return { committed, merged: true, violations: [], changedPaths: changedPaths.map((c) => c.path) };
}

async function mergeBranchIntoIntegration(
  integrationRepoPath: string,
  branch: string,
  baseBranch: string,
  message: string,
): Promise<void> {
  await git(["checkout", baseBranch], integrationRepoPath);
  await git(
    ["merge", "--no-ff", "-m", `silo: integrate ${branch}\n\n${message}`, branch],
    integrationRepoPath,
  );
}
