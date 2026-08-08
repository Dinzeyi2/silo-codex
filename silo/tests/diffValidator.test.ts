import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAndValidateOwnershipConfig } from "../src/ownershipConfigLoader.js";
import { createTaskWorktree, removeTaskWorktree } from "../src/worktreeManager.js";
import { commitAll, validateWorktreeBoundaries } from "../src/diffValidator.js";
import { createTempIntegrationRepo, SAMPLE_OWNERSHIP_PATH } from "./testRepo.js";

const ownership = loadAndValidateOwnershipConfig(SAMPLE_OWNERSHIP_PATH);

describe("worktree isolation + boundary validation (real git)", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createTempIntegrationRepo();
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("reports no violations when a specialist only touches its own owned paths", async () => {
    const handle = await createTaskWorktree({
      integrationRepoPath: repoPath,
      worktreesRoot: path.join(repoPath, ".silo", "worktrees"),
      role: "auth",
      taskId: "clean-1",
      baseBranch: "integration",
      ownership,
    });

    writeFileSync(path.join(handle.worktreePath, "auth", "login.ts"), "export const login = () => {};\n");

    await commitAll(handle.worktreePath, "auth: add login stub");
    const { violations, changedPaths } = await validateWorktreeBoundaries(
      "auth",
      handle.worktreePath,
      "integration",
      ownership,
    );

    expect(violations).toEqual([]);
    expect(changedPaths.map((c) => c.path)).toContain("auth/login.ts");

    await removeTaskWorktree(handle, true);
  });

  it("physically cannot see another domain's existing files inside the worktree", async () => {
    // billing/ has content in the base repo (a .gitkeep at minimum) but is not owned by 'auth'.
    const handle = await createTaskWorktree({
      integrationRepoPath: repoPath,
      worktreesRoot: path.join(repoPath, ".silo", "worktrees"),
      role: "auth",
      taskId: "isolation-1",
      baseBranch: "integration",
      ownership,
    });

    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(handle.worktreePath, "billing"))).toBe(false);
    expect(fs.existsSync(path.join(handle.worktreePath, "db"))).toBe(false);
    expect(fs.existsSync(path.join(handle.worktreePath, "auth"))).toBe(true);
    expect(fs.existsSync(path.join(handle.worktreePath, "architecture"))).toBe(true);

    await removeTaskWorktree(handle, true);
  });

  it("flags a cross-domain write as BOUNDARY_VIOLATION even though the sandboxed filesystem allowed the write", async () => {
    const handle = await createTaskWorktree({
      integrationRepoPath: repoPath,
      worktreesRoot: path.join(repoPath, ".silo", "worktrees"),
      role: "auth",
      taskId: "violation-1",
      baseBranch: "integration",
      ownership,
    });

    // Simulate a misbehaving/compromised auth agent reaching outside its domain.
    mkdirSync(path.join(handle.worktreePath, "db"), { recursive: true });
    writeFileSync(path.join(handle.worktreePath, "db", "users.sql"), "DROP TABLE users;\n");
    writeFileSync(path.join(handle.worktreePath, "auth", "login.ts"), "export const login = () => {};\n");

    await commitAll(handle.worktreePath, "auth: sneaks in a db change");
    const { violations } = await validateWorktreeBoundaries(
      "auth",
      handle.worktreePath,
      "integration",
      ownership,
    );

    expect(violations).toEqual([
      { code: "BOUNDARY_VIOLATION", role: "auth", path: "db/users.sql", owner: "database", operation: "add" },
    ]);

    await removeTaskWorktree(handle, false);
  });

  it("flags an attempt to edit the shared architecture registry", async () => {
    const handle = await createTaskWorktree({
      integrationRepoPath: repoPath,
      worktreesRoot: path.join(repoPath, ".silo", "worktrees"),
      role: "frontend",
      taskId: "violation-2",
      baseBranch: "integration",
      ownership,
    });

    writeFileSync(path.join(handle.worktreePath, "architecture", "product.yaml"), "name: Hijacked Product\n");

    await commitAll(handle.worktreePath, "frontend: rewrites the product spec");
    const { violations } = await validateWorktreeBoundaries(
      "frontend",
      handle.worktreePath,
      "integration",
      ownership,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ owner: "architecture", path: "architecture/product.yaml" });

    await removeTaskWorktree(handle, false);
  });
});
