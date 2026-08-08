import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadAndValidateOwnershipConfig } from "./ownershipConfigLoader.js";
import { loadMembersConfig, MemberDirectory } from "./members.js";
import { loadProvidersConfig, providerConfigForRole } from "./providerConfig.js";
import { loadRegistry, computeRegistryHash } from "./registryLoader.js";
import type { Registry } from "./registryLoader.js";
import { validateRegistry } from "./registryValidator.js";
import { buildRoleContext } from "./promptBuilder.js";
import { createTaskWorktree, removeTaskWorktree } from "./worktreeManager.js";
import { runSpecialistTask } from "./codexRunner.js";
import type { CodexFactory } from "./codexRunner.js";
import { commitValidateAndMerge } from "./mergePipeline.js";
import { ensureProjectRepo, pushBaseBranch } from "./repoManager.js";
import { RegistryValidationError } from "./types.js";
import type { OwnershipConfig, ProvidersConfig, TaskRequest, TaskResult } from "./types.js";
import type { Project } from "./projects.js";

export type SiloConfig = {
  integrationRepoPath: string;
  worktreesRoot: string;
  baseBranch: string;
  ownership: OwnershipConfig;
  registry: Registry;
  registryHash: string;
  members: MemberDirectory;
  providers: ProvidersConfig;
  codexFactory?: CodexFactory;
  /** Set when this repo is a registered SILO project — enables pushing a clean merge to GitHub. */
  project?: Project;
};

export type LoadSiloConfigOptions = {
  integrationRepoPath: string;
  ownershipPath: string;
  registryPath: string;
  membersPath: string;
  providersPath: string;
  worktreesRoot?: string;
  baseBranch?: string;
  codexFactory?: CodexFactory;
  project?: Project;
};

/**
 * Loads and cross-validates every piece of SILO's static configuration: ownership boundaries,
 * the shared architecture registry, the member/role directory, and per-role provider routing.
 * This is the "architecture registry created before coding begins" step — it fails loudly here,
 * before any specialist agent is invoked, rather than letting a broken registry reach a model.
 */
export function loadSiloConfig(opts: LoadSiloConfigOptions): SiloConfig {
  const ownership = loadAndValidateOwnershipConfig(opts.ownershipPath);
  const registry = loadRegistry(opts.registryPath);
  const issues = validateRegistry(registry, ownership);
  if (issues.length > 0) {
    throw new RegistryValidationError(issues);
  }
  const members = new MemberDirectory(loadMembersConfig(opts.membersPath));
  const providers = loadProvidersConfig(opts.providersPath);

  return {
    integrationRepoPath: opts.integrationRepoPath,
    worktreesRoot: opts.worktreesRoot ?? path.join(opts.integrationRepoPath, ".silo", "worktrees"),
    baseBranch: opts.baseBranch ?? "integration",
    ownership,
    registry,
    registryHash: computeRegistryHash(registry),
    members,
    providers,
    codexFactory: opts.codexFactory,
    project: opts.project,
  };
}

/**
 * Runs one specialist task end to end:
 *   1. authorize the member against their assigned role (platform-enforced, not prompt-enforced)
 *   2. create an isolated git worktree scoped to that role's owned paths + the registry
 *   3. run the Codex agent in that worktree, with the role's product/contract context and provider
 *   4. commit, validate the diff against ownership boundaries, and merge only if it's clean
 *
 * On a boundary violation the change is never merged; the branch is kept (not deleted) so it can
 * be audited, and the violations are returned to the caller instead of being silently dropped.
 */
export async function runTask(config: SiloConfig, request: TaskRequest): Promise<TaskResult> {
  const taskId = request.taskId ?? randomUUID();
  const member = config.members.authorize(request.memberId, request.role, config.ownership);
  void member;

  const handle = await createTaskWorktree({
    integrationRepoPath: config.integrationRepoPath,
    worktreesRoot: config.worktreesRoot,
    role: request.role,
    taskId,
    baseBranch: config.baseBranch,
    ownership: config.ownership,
  });

  try {
    const contextPreamble = buildRoleContext(request.role, config.registry);
    const provider = providerConfigForRole(request.role, config.providers);

    let finalResponse: string | null = null;
    let error: string | undefined;
    try {
      const result = await runSpecialistTask({
        role: request.role,
        worktreePath: handle.worktreePath,
        contextPreamble,
        prompt: request.prompt,
        provider,
        codexFactory: config.codexFactory,
      });
      finalResponse = result.finalResponse;
    } catch (err) {
      error = (err as Error).message;
    }

    const commitMessage = `silo(${request.role}): ${request.prompt.slice(0, 72)}`;
    const integration = await commitValidateAndMerge(handle, request.role, config.ownership, commitMessage);

    let pushed: boolean | undefined;
    let pushError: string | undefined;
    if (integration.merged && config.project) {
      try {
        await pushBaseBranch(config.integrationRepoPath, config.project);
        pushed = true;
      } catch (err) {
        // A clean merge that fails to push is still a real, committed merge locally — surface
        // the push failure rather than pretending the task failed outright.
        pushed = false;
        pushError = (err as Error).message;
      }
    }

    const result: TaskResult = {
      taskId,
      role: request.role,
      branch: handle.branch,
      merged: integration.merged,
      violations: integration.violations,
      registryVersion: config.registry.versionsLock.version,
      finalResponse,
      changedPaths: integration.changedPaths,
      error,
      pushed,
      pushError,
    };

    // Keep the branch around for audit whenever it didn't merge (violation, agent error, or no-op);
    // only reclaim the branch once it's safely folded into the integration branch.
    await removeTaskWorktree(handle, integration.merged);

    return result;
  } catch (err) {
    await removeTaskWorktree(handle, false).catch(() => undefined);
    throw err;
  }
}

export type RunProjectTaskOptions = {
  dataDir: string;
  project: Project;
  request: TaskRequest;
  codexFactory?: CodexFactory;
};

/**
 * The multi-project entry point: ensures the project's repo is cloned/synced locally, loads
 * its `silo/config/*` + `architecture/` fresh off that checkout (so registry/ownership/member
 * edits merged upstream take effect on the very next task, no redeploy needed), then runs the
 * task exactly as the single-repo `runTask` does.
 */
export async function runProjectTask(opts: RunProjectTaskOptions): Promise<TaskResult> {
  const repoPath = await ensureProjectRepo(opts.dataDir, opts.project);
  const config = loadSiloConfig({
    integrationRepoPath: repoPath,
    ownershipPath: path.join(repoPath, "silo", "config", "ownership.yaml"),
    membersPath: path.join(repoPath, "silo", "config", "members.yaml"),
    providersPath: path.join(repoPath, "silo", "config", "providers.yaml"),
    registryPath: path.join(repoPath, "architecture"),
    baseBranch: opts.project.baseBranch,
    codexFactory: opts.codexFactory,
    project: opts.project,
  });
  return runTask(config, opts.request);
}
