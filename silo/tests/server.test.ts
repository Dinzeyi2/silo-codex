import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadSiloConfig } from "../src/pipeline.js";
import { createServer } from "../src/server.js";
import type { CodexFactory, ThreadLike } from "../src/codexRunner.js";
import { createTempIntegrationRepo } from "./testRepo.js";

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

describe("SILO HTTP API", () => {
  let repoPath: string;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    repoPath = createTempIntegrationRepo();
    const config = loadSiloConfig({
      integrationRepoPath: repoPath,
      ownershipPath: path.join(repoPath, "silo", "config", "ownership.yaml"),
      membersPath: path.join(repoPath, "silo", "config", "members.yaml"),
      providersPath: path.join(repoPath, "silo", "config", "providers.yaml"),
      registryPath: path.join(repoPath, "architecture"),
      baseBranch: "integration",
      codexFactory: fakeAgent((worktreePath) => {
        writeFileSync(path.join(worktreePath, "db", "schema.sql"), "create table x();\n");
      }),
    });
    server = createServer(config);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("GET /healthz", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /v1/architecture returns the loaded registry", async () => {
    const res = await fetch(`${baseUrl}/v1/architecture`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; contracts: Record<string, unknown> };
    expect(body.version).toBe("1.0.0");
    expect(body.contracts["api:auth"]).toBeDefined();
  });

  it("POST /v1/tasks runs and merges a well-formed task", async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId: "alice", role: "database", prompt: "add x table" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merged: boolean };
    expect(body.merged).toBe(true);
  });

  it("POST /v1/tasks returns 403 ROLE_MISMATCH when the member's role doesn't match", async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memberId: "alice", role: "auth", prompt: "add login" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ROLE_MISMATCH");
  });

  it("POST /v1/tasks returns 400 for a malformed body", async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "database" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/roles returns the ownership registry", async () => {
    const res = await fetch(`${baseUrl}/v1/roles`);
    const body = (await res.json()) as { roles: Record<string, unknown> };
    expect(Object.keys(body.roles)).toEqual(
      expect.arrayContaining(["database", "auth", "frontend", "billing", "intelligence", "infrastructure"]),
    );
  });
});
