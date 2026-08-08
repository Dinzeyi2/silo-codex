import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runProjectTask } from "./pipeline.js";
import { ProjectStore, InvalidProjectError, UnknownProjectError } from "./projects.js";
import { ensureProjectRepo } from "./repoManager.js";
import { loadRegistry } from "./registryLoader.js";
import { loadAndValidateOwnershipConfig } from "./ownershipConfigLoader.js";
import { isAuthorized } from "./serviceAuth.js";
import {
  BoundaryViolationError,
  RegistryValidationError,
  RoleMismatchError,
  UnknownMemberError,
  UnknownRoleError,
} from "./types.js";
import type { TaskRequest } from "./types.js";
import type { CodexFactory } from "./codexRunner.js";
import path from "node:path";

export type CloudServerConfig = {
  dataDir: string;
  serviceToken: string;
  projects: ProjectStore;
  codexFactory?: CodexFactory;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTaskRequest(body: unknown): TaskRequest {
  if (!isRecord(body)) throw new Error("request body must be a JSON object");
  const { memberId, role, prompt, taskId } = body;
  if (typeof memberId !== "string" || !memberId) throw new Error("'memberId' is required");
  if (typeof role !== "string" || !role) throw new Error("'role' is required");
  if (typeof prompt !== "string" || !prompt) throw new Error("'prompt' is required");
  if (taskId !== undefined && typeof taskId !== "string") throw new Error("'taskId' must be a string");
  return { memberId, role, prompt, taskId };
}

/**
 * SILO's cloud/multi-tenant HTTP API: every route (except /healthz) requires
 * `Authorization: Bearer <SILO_SERVICE_TOKEN>` — this is meant to be called server-to-server
 * from your own backend (which has already authenticated the end user and knows their
 * memberId/role), not from a browser. A leaked service token is equivalent to a leaked
 * database credential: it can register projects and run tasks against any of them.
 */
export function createCloudServer(config: CloudServerConfig): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, config).catch((err) => {
      sendJson(res, 500, { code: "INTERNAL_ERROR", message: (err as Error).message });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (!isAuthorized(req.headers.authorization, config.serviceToken)) {
    sendJson(res, 401, { code: "UNAUTHORIZED", message: "missing or invalid Authorization: Bearer token" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/projects") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    if (!isRecord(body)) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: "request body must be a JSON object" });
      return;
    }
    try {
      const { id, name, repoUrl, githubToken, baseBranch } = body;
      const project = config.projects.register({
        id: String(id ?? ""),
        name: String(name ?? id ?? ""),
        repoUrl: String(repoUrl ?? ""),
        githubToken: String(githubToken ?? ""),
        baseBranch: baseBranch === undefined ? undefined : String(baseBranch),
      });
      const { githubToken: _omit, ...safe } = project;
      sendJson(res, 201, safe);
    } catch (err) {
      if (err instanceof InvalidProjectError) {
        sendJson(res, 400, { code: err.code, message: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/projects") {
    sendJson(res, 200, { projects: config.projects.list() });
    return;
  }

  const projectTaskMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/tasks$/);
  if (req.method === "POST" && projectTaskMatch) {
    const projectId = decodeURIComponent(projectTaskMatch[1]!);
    let request: TaskRequest;
    try {
      request = parseTaskRequest(await readJsonBody(req));
    } catch (err) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    try {
      const project = config.projects.require(projectId);
      const result = await runProjectTask({
        dataDir: config.dataDir,
        project,
        request,
        codexFactory: config.codexFactory,
      });
      sendJson(res, result.violations.length > 0 ? 409 : 200, result);
    } catch (err) {
      if (respondToTaskError(res, err)) return;
      throw err;
    }
    return;
  }

  const projectArchMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/architecture$/);
  if (req.method === "GET" && projectArchMatch) {
    const projectId = decodeURIComponent(projectArchMatch[1]!);
    try {
      const project = config.projects.require(projectId);
      const repoPath = await ensureProjectRepo(config.dataDir, project);
      const registry = loadRegistry(path.join(repoPath, "architecture"));
      sendJson(res, 200, {
        version: registry.versionsLock.version,
        product: registry.product,
        domains: registry.domains,
        permissions: registry.permissions,
        dependencies: registry.dependencies,
        contracts: Object.fromEntries(
          Object.entries(registry.contracts).map(([id, c]) => [
            id,
            { kind: c.kind, path: c.relPath, content: c.content },
          ]),
        ),
      });
    } catch (err) {
      if (err instanceof UnknownProjectError) {
        sendJson(res, 404, { code: err.code, message: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  const projectRolesMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/roles$/);
  if (req.method === "GET" && projectRolesMatch) {
    const projectId = decodeURIComponent(projectRolesMatch[1]!);
    try {
      const project = config.projects.require(projectId);
      const repoPath = await ensureProjectRepo(config.dataDir, project);
      const ownership = loadAndValidateOwnershipConfig(
        path.join(repoPath, "silo", "config", "ownership.yaml"),
      );
      sendJson(res, 200, { roles: ownership.roles });
    } catch (err) {
      if (err instanceof UnknownProjectError) {
        sendJson(res, 404, { code: err.code, message: err.message });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 404, { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` });
}

function respondToTaskError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof UnknownProjectError) {
    sendJson(res, 404, { code: err.code, message: err.message, projectId: err.projectId });
    return true;
  }
  if (err instanceof RoleMismatchError) {
    sendJson(res, 403, {
      code: err.code,
      message: err.message,
      memberId: err.memberId,
      requestedRole: err.requestedRole,
      assignedRole: err.assignedRole,
    });
    return true;
  }
  if (err instanceof UnknownMemberError) {
    sendJson(res, 404, { code: err.code, message: err.message, memberId: err.memberId });
    return true;
  }
  if (err instanceof UnknownRoleError) {
    sendJson(res, 400, { code: err.code, message: err.message, role: err.role });
    return true;
  }
  if (err instanceof BoundaryViolationError) {
    sendJson(res, 409, { code: err.code, message: err.message, violations: err.violations });
    return true;
  }
  if (err instanceof RegistryValidationError) {
    sendJson(res, 500, { code: err.code, message: err.message, issues: err.issues });
    return true;
  }
  return false;
}

export function startCloudServer(
  config: CloudServerConfig,
  port = Number(process.env.PORT ?? 8787),
): http.Server {
  const server = createCloudServer(config);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`SILO cloud API listening on :${port}`);
  });
  return server;
}
