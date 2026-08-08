import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadOptions, RunResult } from "@openai/codex-sdk";
import type { ProviderConfig, Role } from "./types.js";

/**
 * Minimal surface of the Codex SDK's `Thread` this module needs. Kept as an interface (rather
 * than importing the concrete class) so tests can inject a fake agent and exercise the full
 * SILO pipeline — role check, sandboxing, boundary validation, merge — without spawning the
 * real Codex binary or calling out to an LLM provider.
 */
export interface ThreadLike {
  run(input: string): Promise<RunResult>;
}

export interface CodexLike {
  startThread(options: ThreadOptions): ThreadLike;
}

export type CodexFactory = (options: CodexOptions) => CodexLike;

/** Default factory: the real Codex SDK, talking to a real Codex CLI binary/provider. */
export const defaultCodexFactory: CodexFactory = (options) => new Codex(options);

export type RunSpecialistTaskParams = {
  role: Role;
  worktreePath: string;
  contextPreamble: string;
  prompt: string;
  provider: ProviderConfig;
  codexFactory?: CodexFactory;
  networkAccessEnabled?: boolean;
};

export type RunSpecialistTaskResult = {
  finalResponse: string;
  turn: RunResult;
};

/**
 * Runs one specialist turn. The agent is bound to `worktreePath` (already sparse-checked-out
 * to the role's owned paths + the shared architecture registry) with `workspace-write`
 * sandboxing, so it can read/write only what's on disk there — it never even has the
 * opportunity to see another domain's implementation files, let alone edit them. The provider
 * (base URL / API key / model) is resolved per role, so different specialists can use entirely
 * different AI vendors.
 */
export async function runSpecialistTask(params: RunSpecialistTaskParams): Promise<RunSpecialistTaskResult> {
  const factory = params.codexFactory ?? defaultCodexFactory;
  const codex = factory({
    baseUrl: params.provider.baseUrl,
    apiKey: params.provider.apiKey,
  });

  const thread = codex.startThread({
    workingDirectory: params.worktreePath,
    sandboxMode: "workspace-write",
    skipGitRepoCheck: false,
    model: params.provider.model,
    modelReasoningEffort: params.provider.modelReasoningEffort,
    networkAccessEnabled: params.networkAccessEnabled ?? false,
    approvalPolicy: "never",
  });

  const input = `${params.contextPreamble}\n\n---\n\n## Task\n\n${params.prompt}`;
  const turn = await thread.run(input);
  return { finalResponse: turn.finalResponse, turn };
}
