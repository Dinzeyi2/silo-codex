import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runTask } from "./pipeline.js";
import type { SiloConfig } from "./pipeline.js";
import {
  BoundaryViolationError,
  RegistryValidationError,
  RoleMismatchError,
  UnknownMemberError,
  UnknownRoleError,
} from "./types.js";
import type { TaskRequest } from "./types.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
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

/** Builds the SILO HTTP API. Kept dependency-free (no express) — a handful of routes doesn't need it. */
export function createServer(config: SiloConfig): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, config).catch((err) => {
      sendJson(res, 500, { code: "INTERNAL_ERROR", message: (err as Error).message });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: SiloConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/roles") {
    sendJson(res, 200, { roles: config.ownership.roles });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/architecture") {
    sendJson(res, 200, {
      version: config.registry.versionsLock.version,
      contentHash: config.registryHash,
      product: config.registry.product,
      domains: config.registry.domains,
      permissions: config.registry.permissions,
      dependencies: config.registry.dependencies,
      contracts: Object.fromEntries(
        Object.entries(config.registry.contracts).map(([id, c]) => [
          id,
          { kind: c.kind, path: c.relPath, content: c.content },
        ]),
      ),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tasks") {
    let request: TaskRequest;
    try {
      request = parseTaskRequest(await readJsonBody(req));
    } catch (err) {
      sendJson(res, 400, { code: "BAD_REQUEST", message: (err as Error).message });
      return;
    }

    try {
      const result = await runTask(config, request);
      sendJson(res, result.violations.length > 0 ? 409 : 200, result);
    } catch (err) {
      if (err instanceof RoleMismatchError) {
        sendJson(res, 403, {
          code: err.code,
          message: err.message,
          memberId: err.memberId,
          requestedRole: err.requestedRole,
          assignedRole: err.assignedRole,
        });
        return;
      }
      if (err instanceof UnknownMemberError) {
        sendJson(res, 404, { code: err.code, message: err.message, memberId: err.memberId });
        return;
      }
      if (err instanceof UnknownRoleError) {
        sendJson(res, 400, { code: err.code, message: err.message, role: err.role });
        return;
      }
      if (err instanceof BoundaryViolationError) {
        sendJson(res, 409, { code: err.code, message: err.message, violations: err.violations });
        return;
      }
      if (err instanceof RegistryValidationError) {
        sendJson(res, 500, { code: err.code, message: err.message, issues: err.issues });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 404, { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` });
}

export function startServer(config: SiloConfig, port = Number(process.env.PORT ?? 8787)): http.Server {
  const server = createServer(config);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`SILO listening on :${port}`);
  });
  return server;
}
