import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A registered target/product repository SILO orchestrates specialist tasks against. */
export type Project = {
  id: string;
  name: string;
  /** HTTPS clone URL, e.g. https://github.com/acme/product.git. SSH is not supported (token auth only). */
  repoUrl: string;
  /** A GitHub token (PAT or App installation token) with read/write access to repoUrl. Never logged, never persisted into git config. */
  githubToken: string;
  /** The shared integration branch specialists merge into. Defaults to "integration". */
  baseBranch: string;
  createdAt: string;
};

export type RegisterProjectInput = {
  id: string;
  name: string;
  repoUrl: string;
  githubToken: string;
  baseBranch?: string;
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class UnknownProjectError extends Error {
  code = "UNKNOWN_PROJECT" as const;
  constructor(public projectId: string) {
    super(`No project with id '${projectId}' is registered.`);
    this.name = "UnknownProjectError";
  }
}

export class InvalidProjectError extends Error {
  code = "INVALID_PROJECT" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

/**
 * A simple file-backed project registry: one JSON file, one row per target repo SILO manages.
 * Good enough for a single SILO instance backed by a persistent volume (e.g. Railway volume
 * mounted at /data). Swap for a real database if you need multiple SILO replicas — this store
 * has no cross-process locking.
 */
export class ProjectStore {
  private byId = new Map<string, Project>();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as { projects?: Project[] };
      for (const project of raw.projects ?? []) {
        this.byId.set(project.id, project);
      }
    }
  }

  get(projectId: string): Project | undefined {
    return this.byId.get(projectId);
  }

  require(projectId: string): Project {
    const project = this.byId.get(projectId);
    if (!project) throw new UnknownProjectError(projectId);
    return project;
  }

  list(): Omit<Project, "githubToken">[] {
    return Array.from(this.byId.values()).map(({ githubToken: _githubToken, ...rest }) => rest);
  }

  register(input: RegisterProjectInput): Project {
    if (!ID_RE.test(input.id)) {
      throw new InvalidProjectError(
        "project id must be 1-64 characters of letters, digits, '.', '_', or '-'",
      );
    }
    if (/^(git@|ssh:\/\/)/i.test(input.repoUrl)) {
      // repoManager authenticates every git call with an HTTP Basic header built from
      // githubToken (see gitAuthed in git.ts) — that's a no-op over SSH, so an ssh:// or
      // git@ URL would silently ignore the token and fail auth in a confusing way.
      throw new InvalidProjectError(
        "repoUrl must not be an SSH remote — SILO authenticates over HTTP(S) using githubToken",
      );
    }
    if (!input.githubToken) {
      throw new InvalidProjectError("githubToken is required");
    }
    const project: Project = {
      id: input.id,
      name: input.name,
      repoUrl: input.repoUrl,
      githubToken: input.githubToken,
      baseBranch: input.baseBranch ?? "integration",
      createdAt: new Date().toISOString(),
    };
    this.byId.set(project.id, project);
    this.persist();
    return project;
  }

  remove(projectId: string): boolean {
    const removed = this.byId.delete(projectId);
    if (removed) this.persist();
    return removed;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write can't corrupt the store the next process reads.
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify({ projects: Array.from(this.byId.values()) }, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}
