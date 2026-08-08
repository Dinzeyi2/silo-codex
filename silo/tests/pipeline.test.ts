import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadSiloConfig, runTask } from "../src/pipeline.js";
import type { SiloConfig } from "../src/pipeline.js";
import type { CodexFactory, ThreadLike } from "../src/codexRunner.js";
import { RoleMismatchError, UnknownMemberError } from "../src/types.js";
import { createTempIntegrationRepo, readTrackedFile } from "./testRepo.js";

/** A fake specialist agent: instead of calling a real model, it just performs a filesystem
 * side effect against the worktree it's handed, exactly as a real Codex turn would. */
function fakeAgent(effect: (worktreePath: string) => void, finalResponse = "done"): CodexFactory {
  return () => ({
    startThread(threadOptions): ThreadLike {
      return {
        async run() {
          effect(threadOptions.workingDirectory!);
          return { items: [], finalResponse, usage: null };
        },
      };
    },
  });
}

function configFor(repoPath: string, codexFactory: CodexFactory): SiloConfig {
  return loadSiloConfig({
    integrationRepoPath: repoPath,
    ownershipPath: path.join(repoPath, "silo", "config", "ownership.yaml"),
    membersPath: path.join(repoPath, "silo", "config", "members.yaml"),
    providersPath: path.join(repoPath, "silo", "config", "providers.yaml"),
    registryPath: path.join(repoPath, "architecture"),
    baseBranch: "integration",
    codexFactory,
  });
}

describe("SILO end-to-end pipeline", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createTempIntegrationRepo();
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("runs a well-behaved specialist task and merges it into the integration branch", async () => {
    const config = configFor(
      repoPath,
      fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "db", "schema.sql"), "create table users (id uuid);\n");
      }),
    );

    const result = await runTask(config, {
      taskId: "task-1",
      memberId: "alice",
      role: "database",
      prompt: "Create the users table.",
    });

    expect(result.merged).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.changedPaths).toContain("db/schema.sql");
    expect(result.finalResponse).toBe("done");
    expect(result.registryVersion).toBe("1.0.0");

    // The change actually landed on the shared integration branch.
    const committed = readTrackedFile(repoPath, "integration", "db/schema.sql");
    expect(committed).toContain("create table users");
  });

  it("rejects a task from a member requesting a role they are not assigned, before touching git at all", async () => {
    const config = configFor(
      repoPath,
      fakeAgent(() => undefined),
    );

    await expect(
      runTask(config, { memberId: "alice", role: "auth", prompt: "add a login endpoint" }),
    ).rejects.toThrow(RoleMismatchError);
  });

  it("rejects a task from an unregistered member", async () => {
    const config = configFor(
      repoPath,
      fakeAgent(() => undefined),
    );
    await expect(
      runTask(config, { memberId: "mallory", role: "database", prompt: "drop everything" }),
    ).rejects.toThrow(UnknownMemberError);
  });

  it("does not merge, and does not let the change reach the integration branch, when a specialist edits another domain's files", async () => {
    const config = configFor(
      repoPath,
      fakeAgent((worktreePath) => {
        // 'bob' is the auth specialist; this reaches into the database domain.
        mkdirSync(path.join(worktreePath, "db"), { recursive: true });
        writeFileSync(path.join(worktreePath, "db", "hack.sql"), "DROP TABLE users;\n");
        writeFileSync(path.join(worktreePath, "auth", "login.ts"), "export const login = () => {};\n");
      }),
    );

    const result = await runTask(config, {
      taskId: "task-2",
      memberId: "bob",
      role: "auth",
      prompt: "add a login endpoint",
    });

    expect(result.merged).toBe(false);
    expect(result.violations).toEqual([
      { code: "BOUNDARY_VIOLATION", role: "auth", path: "db/hack.sql", owner: "database", operation: "add" },
    ]);

    // Nothing — not even the legitimate auth/login.ts change — reached the integration branch:
    // a boundary violation rejects the whole change set, it doesn't cherry-pick the clean parts.
    expect(() => readTrackedFile(repoPath, "integration", "db/hack.sql")).toThrow();
    expect(() => readTrackedFile(repoPath, "integration", "auth/login.ts")).toThrow();

    // But the branch itself is preserved (not deleted) so the violation can be audited.
    const { execFileSync } = await import("node:child_process");
    const branches = execFileSync("git", ["branch", "--list", result.branch], {
      cwd: repoPath,
      encoding: "utf8",
    });
    expect(branches).toContain(result.branch);
  });

  it("does not merge when a specialist edits the shared architecture registry", async () => {
    const config = configFor(
      repoPath,
      fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "architecture", "product.yaml"), "name: Hijacked\n");
      }),
    );

    const result = await runTask(config, {
      taskId: "task-3",
      memberId: "carol",
      role: "frontend",
      prompt: "redesign the product",
    });

    expect(result.merged).toBe(false);
    expect(result.violations[0]).toMatchObject({ owner: "architecture", path: "architecture/product.yaml" });
  });

  it("surfaces the agent's error without crashing the pipeline, and does not merge", async () => {
    const config: SiloConfig = configFor(repoPath, () => ({
      startThread: () => ({
        run: async () => {
          throw new Error("provider request failed: 500");
        },
      }),
    }));

    const result = await runTask(config, {
      taskId: "task-4",
      memberId: "alice",
      role: "database",
      prompt: "add an index",
    });

    expect(result.merged).toBe(false);
    expect(result.finalResponse).toBeNull();
    expect(result.error).toContain("provider request failed");
  });

  it("runs two roles concurrently, each in its own worktree, and both merge cleanly", async () => {
    const dbConfig = configFor(
      repoPath,
      fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "db", "schema.sql"), "create table subscriptions (id uuid);\n");
      }),
    );
    const authConfig = configFor(
      repoPath,
      fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "auth", "session.ts"), "export const session = () => {};\n");
      }),
    );

    const [dbResult, authResult] = await Promise.all([
      runTask(dbConfig, { taskId: "concurrent-db", memberId: "alice", role: "database", prompt: "x" }),
      runTask(authConfig, { taskId: "concurrent-auth", memberId: "bob", role: "auth", prompt: "y" }),
    ]);

    expect(dbResult.merged).toBe(true);
    expect(authResult.merged).toBe(true);
    expect(readTrackedFile(repoPath, "integration", "db/schema.sql")).toContain("subscriptions");
    expect(readTrackedFile(repoPath, "integration", "auth/session.ts")).toContain("session");
  });
});
