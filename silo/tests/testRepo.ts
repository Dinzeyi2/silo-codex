import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// `pnpm run` (and jest, which we always invoke through it) sets cwd to this package's root,
// so this is a stable anchor without needing `import.meta.url` (which ts-jest's ESM preset
// only supports via an extra AST-transform dependency — not worth it for a test-only path).
const PACKAGE_ROOT = process.cwd();

export const SAMPLE_PROJECT = path.join(PACKAGE_ROOT, "examples", "sample-project");
export const SAMPLE_OWNERSHIP_PATH = path.join(SAMPLE_PROJECT, "silo", "config", "ownership.yaml");
export const SAMPLE_MEMBERS_PATH = path.join(SAMPLE_PROJECT, "silo", "config", "members.yaml");
export const SAMPLE_PROVIDERS_PATH = path.join(SAMPLE_PROJECT, "silo", "config", "providers.yaml");
export const SAMPLE_REGISTRY_PATH = path.join(SAMPLE_PROJECT, "architecture");

/** Copies the bundled sample-project into a fresh temp dir and turns it into a one-commit repo on `integration`. */
export function createTempIntegrationRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "silo-repo-"));
  cpSync(SAMPLE_PROJECT, dir, { recursive: true });
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "silo-test@example.com"]);
  run(["config", "user.name", "silo-test"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "initial import of sample-project"]);
  run(["branch", "-M", "integration"]);
  return dir;
}

export function readTrackedFile(repoPath: string, ref: string, relPath: string): string {
  return execFileSync("git", ["show", `${ref}:${relPath}`], { cwd: repoPath, encoding: "utf8" });
}

/**
 * Creates a local bare git repo (under `dir`) seeded with the bundled sample-project, to stand
 * in for a project's real GitHub remote in tests. `http.extraHeader` auth (what repoManager
 * sends on every request) is a no-op for a local path transport, so this exercises the exact
 * same clone/fetch/reset/push plumbing a real HTTPS remote would.
 */
export function createBareOriginFromSampleProject(dir: string): string {
  const seed = path.join(dir, "seed");
  const bare = path.join(dir, "origin.git");
  cpSync(SAMPLE_PROJECT, seed, { recursive: true });
  const run = (args: string[], cwd: string): void => {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  };
  run(["init", "-q"], seed);
  run(["config", "user.email", "silo-test@example.com"], seed);
  run(["config", "user.name", "silo-test"], seed);
  run(["add", "-A"], seed);
  run(["commit", "-q", "-m", "initial import of sample-project"], seed);
  run(["branch", "-M", "integration"], seed);
  run(["clone", "-q", "--bare", seed, bare], dir);
  return bare;
}
