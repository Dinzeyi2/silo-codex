import { runSpecialistTask } from "../src/codexRunner.js";
import type { CodexFactory, ThreadLike } from "../src/codexRunner.js";
import type { CodexOptions, ThreadOptions, RunResult } from "@openai/codex-sdk";

describe("runSpecialistTask", () => {
  it("scopes the agent to the worktree, applies the role's provider config, and runs the composed prompt", async () => {
    const captured: { codexOptions?: CodexOptions; threadOptions?: ThreadOptions; input?: string } = {};

    const fakeFactory: CodexFactory = (options) => {
      captured.codexOptions = options;
      return {
        startThread(threadOptions: ThreadOptions): ThreadLike {
          captured.threadOptions = threadOptions;
          return {
            async run(input: string): Promise<RunResult> {
              captured.input = input;
              return { items: [], finalResponse: "created users table", usage: null };
            },
          };
        },
      };
    };

    const result = await runSpecialistTask({
      role: "database",
      worktreePath: "/repo/worktrees/silo-database-t1",
      contextPreamble: "## Context",
      prompt: "Add a users table.",
      provider: { baseUrl: "https://db-provider.example.com", apiKey: "sk-db-1", model: "gpt-silo-db" },
      codexFactory: fakeFactory,
    });

    expect(captured.codexOptions).toEqual({ baseUrl: "https://db-provider.example.com", apiKey: "sk-db-1" });
    expect(captured.threadOptions).toMatchObject({
      workingDirectory: "/repo/worktrees/silo-database-t1",
      sandboxMode: "workspace-write",
      model: "gpt-silo-db",
      networkAccessEnabled: false,
      approvalPolicy: "never",
    });
    expect(captured.input).toContain("## Context");
    expect(captured.input).toContain("Add a users table.");
    expect(result.finalResponse).toBe("created users table");
  });

  it("lets different roles use entirely different providers in the same process", async () => {
    const seen: (CodexOptions | undefined)[] = [];
    const fakeFactory: CodexFactory = (options) => {
      seen.push(options);
      return {
        startThread: () => ({ run: async () => ({ items: [], finalResponse: "ok", usage: null }) }),
      };
    };

    await runSpecialistTask({
      role: "database",
      worktreePath: "/repo/db",
      contextPreamble: "",
      prompt: "",
      provider: { baseUrl: "https://vendor-a.example.com", apiKey: "sk-a" },
      codexFactory: fakeFactory,
    });
    await runSpecialistTask({
      role: "auth",
      worktreePath: "/repo/auth",
      contextPreamble: "",
      prompt: "",
      provider: { baseUrl: "https://vendor-b.example.com", apiKey: "sk-b" },
      codexFactory: fakeFactory,
    });

    expect(seen).toEqual([
      { baseUrl: "https://vendor-a.example.com", apiKey: "sk-a" },
      { baseUrl: "https://vendor-b.example.com", apiKey: "sk-b" },
    ]);
  });
});
