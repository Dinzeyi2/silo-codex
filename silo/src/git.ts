import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitResult = { stdout: string; stderr: string };

/** Thin wrapper around invoking `git` as a subprocess, so higher-level modules stay testable. */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${e.stderr || e.message}`);
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return stdout.trim();
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}
