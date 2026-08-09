import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from .config import Config
from .registry import ArchitectureRegistry
from .store import JobStore


class IntegrationError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class Integrator:
    def __init__(self, config: Config, store: JobStore):
        self.config = config
        self.store = store
        self.lock = threading.Lock()
        self.candidates = Path(config.project_root.parent, ".silo-integration")
        self.candidates.mkdir(exist_ok=True)
        self._remove_abandoned_candidates()

    def _remove_abandoned_candidates(self) -> None:
        for candidate in self.candidates.iterdir():
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(candidate)],
                cwd=self.config.project_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            shutil.rmtree(candidate, ignore_errors=True)
        subprocess.run(
            ["git", "worktree", "prune"],
            cwd=self.config.project_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def integrate(self, job: dict) -> dict:
        if job["status"] != "ready":
            raise IntegrationError("JOB_NOT_READY", "only ready jobs can be integrated")
        registry = ArchitectureRegistry(
            self.config.project_root, self.config.max_architecture_bytes
        )
        if registry.digest() != job["architecture_digest"]:
            raise IntegrationError(
                "ARCHITECTURE_CHANGED", "job used an outdated architecture version"
            )
        with self.lock:
            self._validate_integration_checkout()
            return self._validate_and_merge(job)

    def _validate_integration_checkout(self) -> None:
        branch = self._git("branch", "--show-current")
        if branch != self.config.integration_branch:
            raise IntegrationError(
                "WRONG_INTEGRATION_BRANCH",
                "project repository is not on the configured integration branch",
            )
        if self._git("status", "--porcelain"):
            raise IntegrationError(
                "INTEGRATION_DIRTY", "integration repository has uncommitted changes"
            )

    def _validate_and_merge(self, job: dict) -> dict:
        candidate = self.candidates / f"{job['id']}-{uuid.uuid4().hex}"
        self.store.update(job["id"], status="integrating")
        try:
            self._git("worktree", "add", "--detach", str(candidate), "HEAD")
            self._git(
                "-c",
                "user.name=SILO",
                "-c",
                "user.email=silo@localhost",
                "cherry-pick",
                job["commit_sha"],
                cwd=candidate,
                error_code="INTEGRATION_CONFLICT",
            )
            for command in self.config.integration_checks:
                check = subprocess.run(
                    command,
                    cwd=candidate,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                if check.returncode:
                    raise IntegrationError(
                        "INTEGRATION_CHECK_FAILED", check.stdout[-2000:]
                    )
            candidate_sha = self._git("rev-parse", "HEAD", cwd=candidate)
            self._git("merge", "--ff-only", candidate_sha)
            self.store.update(
                job["id"], status="integrated", error_code=None, error_message=None
            )
            return self.store.get(job["id"])
        except IntegrationError as error:
            self.store.update(
                job["id"],
                status="ready",
                error_code=error.code,
                error_message=str(error),
            )
            raise
        except Exception as error:
            wrapped = IntegrationError("INTEGRATION_FAILED", str(error)[:2000])
            self.store.update(
                job["id"],
                status="ready",
                error_code=wrapped.code,
                error_message=str(wrapped),
            )
            raise wrapped from error
        finally:
            if candidate.exists():
                subprocess.run(
                    ["git", "worktree", "remove", "--force", str(candidate)],
                    cwd=self.config.project_root,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            shutil.rmtree(candidate, ignore_errors=True)

    def _git(
        self,
        *args: str,
        cwd: Path | None = None,
        error_code: str = "INTEGRATION_FAILED",
    ) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd or self.config.project_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode:
            raise IntegrationError(error_code, result.stderr[-2000:])
        return result.stdout.strip()
