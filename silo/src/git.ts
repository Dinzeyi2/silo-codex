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

function redact(text: string | undefined, secrets: string[]): string | undefined {
  if (!text) return text;
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Like `git`, but injects a GitHub token as a per-invocation `http.extraHeader` — never written
 * to the repo's `.git/config` or embedded in a remote URL, so it can't leak via `git remote -v`,
 * shell history from a copied command, or a committed config file. The token (and its base64
 * form) is redacted from any thrown error message, since git's own stderr on an auth failure
 * can otherwise echo back the request it made.
 */
export async function gitAuthed(args: string[], cwd: string, githubToken: string): Promise<GitResult> {
  const basicAuth = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  const authArgs = ["-c", `http.extraHeader=AUTHORIZATION: basic ${basicAuth}`];
  try {
    const { stdout, stderr } = await execFileAsync("git", [...authArgs, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const secrets = [githubToken, basicAuth];
    const detail = redact(e.stderr, secrets) || redact(e.message, secrets);
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) failed: ${detail}`);
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

export async function remoteBranchExists(cwd: string, githubToken: string, branch: string): Promise<boolean> {
  const { stdout } = await gitAuthed(["ls-remote", "--heads", "origin", branch], cwd, githubToken);
  return stdout.trim().length > 0;
}
