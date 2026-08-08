import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { branchExists, git, gitAuthed, remoteBranchExists } from "./git.js";
import { withLock } from "./asyncLock.js";
import type { Project } from "./projects.js";

/** Where a project's integration repo lives on disk, given a SILO data directory. */
export function repoPathForProject(dataDir: string, project: Project): string {
  return path.join(dataDir, "repos", project.id);
}

/**
 * Ensures the project's repo is cloned locally and its base/integration branch is checked out
 * and up to date with `origin`. Safe to call before every task — clone happens once, every
 * later call is a cheap fetch + reset. Serialized per repo path: this mutates the same shared
 * working directory `worktreeManager`/`mergePipeline` operate on.
 */
export async function ensureProjectRepo(dataDir: string, project: Project): Promise<string> {
  const repoPath = repoPathForProject(dataDir, project);
  return withLock(repoPath, async () => {
    if (existsSync(path.join(repoPath, ".git"))) {
      await syncBaseBranch(repoPath, project);
      return repoPath;
    }

    mkdirSync(path.dirname(repoPath), { recursive: true });
    await gitAuthed(
      ["clone", "--no-checkout", project.repoUrl, repoPath],
      path.dirname(repoPath),
      project.githubToken,
    );

    const hasRemoteBase = await remoteBranchExists(repoPath, project.githubToken, project.baseBranch);
    if (hasRemoteBase) {
      await git(["checkout", project.baseBranch], repoPath);
    } else {
      // First time SILO has touched this repo and the base branch doesn't exist upstream yet:
      // create it from whatever the default branch's HEAD is.
      await git(["checkout", "-b", project.baseBranch], repoPath);
    }
    return repoPath;
  });
}

async function syncBaseBranch(repoPath: string, project: Project): Promise<void> {
  await gitAuthed(["fetch", "origin", project.baseBranch], repoPath, project.githubToken).catch(
    () => undefined,
  );
  const hasRemoteBase = await remoteBranchExists(repoPath, project.githubToken, project.baseBranch);

  if (!(await branchExists(repoPath, project.baseBranch))) {
    await git(
      hasRemoteBase
        ? ["checkout", "-b", project.baseBranch, `origin/${project.baseBranch}`]
        : ["checkout", "-b", project.baseBranch],
      repoPath,
    );
  } else {
    await git(["checkout", project.baseBranch], repoPath);
    if (hasRemoteBase) {
      // The remote is the source of truth: discard any stray local drift on the base branch
      // itself (specialist work never happens here directly — it happens in worktrees).
      await git(["reset", "--hard", `origin/${project.baseBranch}`], repoPath);
    }
  }
}

/** Pushes the local base/integration branch to `origin`, after a successful merge. */
export async function pushBaseBranch(repoPath: string, project: Project): Promise<void> {
  await withLock(repoPath, () =>
    gitAuthed(
      ["push", "origin", `${project.baseBranch}:${project.baseBranch}`],
      repoPath,
      project.githubToken,
    ),
  );
}
