import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureProjectRepo, pushBaseBranch, repoPathForProject } from "../src/repoManager.js";
import type { Project } from "../src/projects.js";

/**
 * repoManager talks to `origin` over whatever transport the URL implies. A local bare repo
 * (file:// / plain path) exercises the exact same clone/fetch/checkout/reset/push plumbing as
 * a real GitHub HTTPS remote would, without making a network call — git only applies
 * `http.extraHeader` to http(s) transports, so it's a harmless no-op here.
 */
function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}

function createBareOrigin(dir: string): string {
  const seed = path.join(dir, "seed");
  const bare = path.join(dir, "origin.git");
  mkdirSync(seed, { recursive: true });
  run("git", ["init", "-q"], seed);
  run("git", ["config", "user.email", "seed@example.com"], seed);
  run("git", ["config", "user.name", "seed"], seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  run("git", ["add", "-A"], seed);
  run("git", ["commit", "-q", "-m", "init"], seed);
  run("git", ["branch", "-M", "integration"], seed);
  run("git", ["clone", "-q", "--bare", seed, bare], dir);
  return bare;
}

describe("repoManager (against a local bare 'origin')", () => {
  let dir: string;
  let dataDir: string;
  let project: Project;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "silo-repomanager-"));
    dataDir = path.join(dir, "data");
    const bareOrigin = createBareOrigin(dir);
    project = {
      id: "acme",
      name: "Acme",
      repoUrl: bareOrigin,
      githubToken: "unused-for-local-transport",
      baseBranch: "integration",
      createdAt: new Date().toISOString(),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clones the project on first call and checks out the base branch", async () => {
    const repoPath = await ensureProjectRepo(dataDir, project);
    expect(repoPath).toBe(repoPathForProject(dataDir, project));
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("hello\n");
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
    });
    expect(branch.trim()).toBe("integration");
  });

  it("is idempotent: a second call reuses the existing clone", async () => {
    const first = await ensureProjectRepo(dataDir, project);
    const second = await ensureProjectRepo(dataDir, project);
    expect(second).toBe(first);
  });

  it("pushes local commits to the remote", async () => {
    const repoPath = await ensureProjectRepo(dataDir, project);
    writeFileSync(path.join(repoPath, "new-file.txt"), "from silo\n");
    run("git", ["add", "-A"], repoPath);
    run(
      "git",
      ["-c", "user.email=silo@example.com", "-c", "user.name=silo", "commit", "-q", "-m", "silo change"],
      repoPath,
    );

    await pushBaseBranch(repoPath, project);

    // Verify by cloning the bare origin fresh, independent of repoManager.
    const verifyDir = path.join(dir, "verify");
    run("git", ["clone", "-q", "-b", "integration", project.repoUrl, verifyDir], dir);
    expect(readFileSync(path.join(verifyDir, "new-file.txt"), "utf8")).toBe("from silo\n");
  });

  it("pulls in commits pushed to the remote by someone else on the next sync", async () => {
    // First SILO clone.
    const repoPath = await ensureProjectRepo(dataDir, project);

    // A teammate pushes directly, bypassing SILO entirely.
    const teammateDir = path.join(dir, "teammate");
    run("git", ["clone", "-q", "-b", "integration", project.repoUrl, teammateDir], dir);
    writeFileSync(path.join(teammateDir, "teammate.txt"), "hi\n");
    run("git", ["add", "-A"], teammateDir);
    run(
      "git",
      [
        "-c",
        "user.email=teammate@example.com",
        "-c",
        "user.name=teammate",
        "commit",
        "-q",
        "-m",
        "teammate change",
      ],
      teammateDir,
    );
    run("git", ["push", "-q", "origin", "integration"], teammateDir);

    // SILO's next sync should pick it up.
    await ensureProjectRepo(dataDir, project);
    expect(readFileSync(path.join(repoPath, "teammate.txt"), "utf8")).toBe("hi\n");
  });
});
