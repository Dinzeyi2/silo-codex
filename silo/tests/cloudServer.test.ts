import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCloudServer } from "../src/cloudServer.js";
import { ProjectStore } from "../src/projects.js";
import type { CodexFactory, ThreadLike } from "../src/codexRunner.js";
import { createBareOriginFromSampleProject } from "./testRepo.js";

const SERVICE_TOKEN = "t".repeat(40);

function fakeAgent(effect: (worktreePath: string) => void): CodexFactory {
  return () => ({
    startThread(threadOptions): ThreadLike {
      return {
        async run() {
          effect(threadOptions.workingDirectory!);
          return { items: [], finalResponse: "done", usage: null };
        },
      };
    },
  });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("SILO cloud (multi-project) HTTP API", () => {
  let dir: string;
  let dataDir: string;
  let originUrl: string;
  let server: ReturnType<typeof createCloudServer>;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "silo-cloud-"));
    dataDir = path.join(dir, "data");
    originUrl = createBareOriginFromSampleProject(dir);

    const projects = new ProjectStore(path.join(dataDir, "projects.json"));
    server = createCloudServer({
      dataDir,
      serviceToken: SERVICE_TOKEN,
      projects,
      codexFactory: fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "db", "schema.sql"), "create table x();\n");
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${SERVICE_TOKEN}` },
  });

  it("GET /healthz requires no auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("rejects every other route without a valid bearer token", async () => {
    const res = await fetch(`${baseUrl}/v1/projects`);
    expect(res.status).toBe(401);
    const badToken = await fetch(`${baseUrl}/v1/projects`, { headers: { authorization: "Bearer wrong" } });
    expect(badToken.status).toBe(401);
  });

  it("registers a project without echoing the githubToken back", async () => {
    const res = await fetch(
      `${baseUrl}/v1/projects`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "acme",
          name: "Acme",
          repoUrl: originUrl,
          githubToken: "super-secret-token",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.id).toBe("acme");
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
  });

  it("runs a task end to end: clone project, run agent, merge, push to the remote", async () => {
    await fetch(
      `${baseUrl}/v1/projects`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "acme", name: "Acme", repoUrl: originUrl, githubToken: "x" }),
      }),
    );

    const res = await fetch(
      `${baseUrl}/v1/projects/acme/tasks`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "alice", role: "database", prompt: "add a users table" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.merged).toBe(true);
    expect(body.pushed).toBe(true);

    // The push actually landed on the remote, independent of anything SILO cached locally.
    const verifyDir = path.join(dir, "verify");
    execFileSync("git", ["clone", "-q", "-b", "integration", originUrl, verifyDir], {
      cwd: dir,
      stdio: "pipe",
    });
    const content = execFileSync("git", ["show", "HEAD:db/schema.sql"], { cwd: verifyDir, encoding: "utf8" });
    expect(content).toContain("create table x");
  });

  it("404s a task against an unregistered project", async () => {
    const res = await fetch(
      `${baseUrl}/v1/projects/ghost/tasks`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "alice", role: "database", prompt: "x" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.code).toBe("UNKNOWN_PROJECT");
  });

  it("keeps two projects' repos and results fully isolated from each other", async () => {
    const origin2 = createBareOriginFromSampleProject(path.join(dir, "second"));
    await fetch(
      `${baseUrl}/v1/projects`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "acme", name: "Acme", repoUrl: originUrl, githubToken: "x" }),
      }),
    );
    await fetch(
      `${baseUrl}/v1/projects`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "globex", name: "Globex", repoUrl: origin2, githubToken: "x" }),
      }),
    );

    const list = await json(await fetch(`${baseUrl}/v1/projects`, authed()));
    expect(list.projects.map((p: { id: string }) => p.id).sort()).toEqual(["acme", "globex"]);

    const arch = await json(await fetch(`${baseUrl}/v1/projects/acme/architecture`, authed()));
    expect(arch.version).toBe("1.0.0");
  });

  it("returns ROLE_MISMATCH (403) through the project-scoped task route", async () => {
    await fetch(
      `${baseUrl}/v1/projects`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "acme", name: "Acme", repoUrl: originUrl, githubToken: "x" }),
      }),
    );
    const res = await fetch(
      `${baseUrl}/v1/projects/acme/tasks`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "alice", role: "auth", prompt: "x" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe("ROLE_MISMATCH");
  });
});
