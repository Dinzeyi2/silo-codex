import json
import os
import re
import shutil
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .config import Config, Principal, load_config
from .jobs import JobCapacityError, JobRunner
from .integration import IntegrationError, Integrator
from .registry import ArchitectureRegistry
from .store import JobStore

JOB_PATH = re.compile(r"^/v1/jobs/([0-9a-f]{32})$")
INTEGRATE_PATH = re.compile(r"^/v1/jobs/([0-9a-f]{32})/integrate$")


class SiloServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, config: Config):
        validate_runtime(config)
        super().__init__(address, Handler)
        self.config = config
        self.store = JobStore(
            Path(os.environ.get("SILO_DATABASE", "/data/silo/silo.db"))
        )
        self.store.fail_interrupted()
        self.runner = JobRunner(config, self.store)
        self.integrator = Integrator(config, self.store)


def validate_runtime(config: Config) -> None:
    if not shutil.which("codex"):
        raise RuntimeError("codex executable is not available")
    repository = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=config.project_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if repository.returncode or repository.stdout.strip() != "true":
        raise RuntimeError("projectRoot must be an existing Git worktree")
    branch = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=config.project_root,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    if branch != config.integration_branch:
        raise RuntimeError("projectRoot must be on the configured integration branch")
    registry = ArchitectureRegistry(config.project_root, config.max_architecture_bytes)
    architecture = registry.load()
    registry.validate_owners(architecture, set(config.roles))


class Handler(BaseHTTPRequestHandler):
    server: SiloServer

    def log_message(self, message, *args):
        print(
            json.dumps(
                {
                    "level": "info",
                    "remote": self.client_address[0],
                    "message": message % args,
                }
            ),
            flush=True,
        )

    def _json(self, status: HTTPStatus, value: dict):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: HTTPStatus, code: str, message: str):
        self._json(status, {"error": {"code": code, "message": message}})

    def _token(self) -> str | None:
        value = self.headers.get("Authorization", "")
        return value[7:] if value.startswith("Bearer ") else None

    def _principal(self) -> Principal | None:
        token = self._token()
        principal = self.server.config.authenticate(token or "")
        if not principal:
            self._error(
                HTTPStatus.UNAUTHORIZED,
                "UNAUTHENTICATED",
                "a valid bearer token is required",
            )
        return principal

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > self.server.config.max_task_bytes + 4096:
            raise ValueError("request body size is invalid")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/healthz":
            self._json(HTTPStatus.OK, {"status": "ok"})
            return
        principal = self._principal()
        if not principal:
            return
        if path == "/v1/me":
            self._json(
                HTTPStatus.OK, {"subject": principal.subject, "role": principal.role}
            )
        elif path == "/v1/architecture":
            registry = ArchitectureRegistry(
                self.server.config.project_root,
                self.server.config.max_architecture_bytes,
            )
            architecture = registry.load()
            registry.validate_owners(architecture, set(self.server.config.roles))
            self._json(
                HTTPStatus.OK,
                architecture,
            )
        elif match := JOB_PATH.match(path):
            job = self.server.store.get(match.group(1))
            if not job:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "job not found")
            elif job["subject"] != principal.subject:
                self._error(
                    HTTPStatus.FORBIDDEN, "FORBIDDEN", "job belongs to another user"
                )
            else:
                self._json(HTTPStatus.OK, job)
        else:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "route not found")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/v1/jobs":
                principal = self._principal()
                if not principal:
                    return
                body = self._body()
                job = self.server.runner.submit(
                    principal, body.get("role", ""), body.get("task", "")
                )
                self.server.store.audit(
                    principal.subject,
                    "job.submitted",
                    job["id"],
                    {"role": principal.role},
                )
                self._json(HTTPStatus.ACCEPTED, job)
            elif match := INTEGRATE_PATH.match(path):
                self._integrate(match.group(1))
            else:
                self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "route not found")
        except PermissionError as error:
            self._error(HTTPStatus.FORBIDDEN, "ROLE_MISMATCH", str(error))
        except JobCapacityError as error:
            self._error(HTTPStatus.TOO_MANY_REQUESTS, "CAPACITY_EXCEEDED", str(error))
        except (ValueError, json.JSONDecodeError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST", str(error))
        except Exception as error:
            self.log_error("unhandled request error: %s", error)
            self._error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "the request could not be completed",
            )

    def _integrate(self, job_id: str):
        if not self.server.config.is_admin(self._token() or ""):
            self._error(
                HTTPStatus.FORBIDDEN,
                "ADMIN_REQUIRED",
                "an administrator token is required",
            )
            return
        job = self.server.store.get(job_id)
        if not job:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "job not found")
            return
        try:
            result = self.server.integrator.integrate(job)
            self.server.store.audit("admin", "job.integrated", job_id)
            self._json(HTTPStatus.OK, result)
        except IntegrationError as error:
            self.server.store.audit(
                "admin", "job.integration_rejected", job_id, {"code": error.code}
            )
            self._error(HTTPStatus.CONFLICT, error.code, str(error))


def main():
    config = load_config()
    host = os.environ.get("SILO_HOST", "127.0.0.1")
    port = int(os.environ.get("SILO_PORT", "4600"))
    server = SiloServer((host, port), config)
    print(
        json.dumps(
            {
                "level": "info",
                "message": "SILO server started",
                "host": host,
                "port": port,
            }
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
