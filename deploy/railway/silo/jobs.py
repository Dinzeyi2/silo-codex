import json
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

from .config import Config, Principal
from .policy import BoundaryViolation
from .registry import ArchitectureRegistry
from .store import JobStore


class JobCapacityError(RuntimeError):
    pass


class JobRunner:
    def __init__(self, config: Config, store: JobStore):
        self.config = config
        self.store = store
        self.worktrees = Path(os.environ.get("SILO_WORKTREES", "/data/silo/worktrees"))
        self.worktrees.mkdir(parents=True, exist_ok=True)
        self._remove_abandoned_worktrees()
        self.capacity = threading.BoundedSemaphore(config.max_concurrent_jobs)

    def _remove_abandoned_worktrees(self) -> None:
        for worktree in self.worktrees.iterdir():
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=self.config.project_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            shutil.rmtree(worktree, ignore_errors=True)
        subprocess.run(
            ["git", "worktree", "prune"],
            cwd=self.config.project_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def submit(self, principal: Principal, role: str, task: str) -> dict:
        if role != principal.role:
            raise PermissionError("requested specialist does not match assigned role")
        if role not in self.config.roles:
            raise ValueError("unknown role")
        if not task.strip() or len(task.encode()) > self.config.max_task_bytes:
            raise ValueError("task is empty or exceeds the configured size limit")
        registry = ArchitectureRegistry(
            self.config.project_root, self.config.max_architecture_bytes
        )
        architecture = registry.load()
        registry.validate_owners(architecture, set(self.config.roles))
        job_id = uuid.uuid4().hex
        job = {
            "id": job_id,
            "subject": principal.subject,
            "role": role,
            "task": task,
            "branch": f"silo/{role}/{job_id}",
            "architectureDigest": architecture["digest"],
        }
        self.store.create(job)
        if not self.capacity.acquire(blocking=False):
            self.store.update(
                job_id,
                status="failed",
                error_code="CAPACITY_EXCEEDED",
                error_message="too many jobs are running",
            )
            raise JobCapacityError("too many jobs are running")
        threading.Thread(target=self._run_and_release, args=(job,), daemon=True).start()
        return self.store.get(job_id)

    def _run_and_release(self, job: dict) -> None:
        try:
            self._run(job)
        finally:
            self.capacity.release()

    def _git(self, *args: str, cwd: Path | None = None) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd or self.config.project_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return result.stdout.strip()

    def _run(self, job: dict) -> None:
        job_id = job["id"]
        worktree = self.worktrees / job_id
        try:
            self.store.update(job_id, status="running")
            self._git(
                "worktree",
                "add",
                "-b",
                job["branch"],
                str(worktree),
                self.config.integration_branch,
            )
            roots = self.config.roles[job["role"]].writable_roots
            self._git(
                "sparse-checkout", "set", "--no-cone", ".silo/", *roots, cwd=worktree
            )
            registry = ArchitectureRegistry(
                worktree, self.config.max_architecture_bytes
            ).load()
            if registry["digest"] != job["architectureDigest"]:
                raise RuntimeError("architecture changed before the job started")
            prompt = self._prompt(job, registry)
            env = os.environ.copy()
            env["SILO_ROLE"] = job["role"]
            role = self.config.roles[job["role"]]
            command = [
                "codex",
                "exec",
                "--full-auto",
                "--ephemeral",
                "--skip-git-repo-check",
            ]
            if role.model_provider:
                command.extend(["--config", f'model_provider="{role.model_provider}"'])
            if role.model:
                command.extend(["--model", role.model])
            command.append(prompt)
            subprocess.run(
                command,
                cwd=worktree,
                env=env,
                check=True,
                timeout=self.config.job_timeout_seconds,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
            changed = self._changed_paths(worktree)
            if not changed:
                raise RuntimeError("agent completed without changing any files")
            self.config.roles[job["role"]].validate(changed, self.config.roles)
            self._reject_symlinks(worktree, changed, job["role"])
            self._git("add", "--", *changed, cwd=worktree)
            self._git(
                "-c",
                "user.name=SILO",
                "-c",
                "user.email=silo@localhost",
                "commit",
                "-m",
                f"SILO {job['role']} job {job_id}",
                cwd=worktree,
            )
            commit_sha = self._git("rev-parse", "HEAD", cwd=worktree)
            self.store.update(
                job_id,
                status="ready",
                changed_paths=json.dumps(changed),
                commit_sha=commit_sha,
            )
            self.store.audit(job["subject"], "job.ready", job_id, {"role": job["role"]})
        except BoundaryViolation as error:
            self._discard(worktree)
            self.store.update(
                job_id,
                status="rejected",
                error_code="BOUNDARY_VIOLATION",
                error_message=str(error),
            )
            self.store.audit(
                job["subject"],
                "job.boundary_rejected",
                job_id,
                {"role": job["role"], "path": error.path},
            )
        except Exception as error:
            self._discard(worktree)
            self.store.update(
                job_id,
                status="failed",
                error_code="JOB_FAILED",
                error_message=str(error)[:2000],
            )
        finally:
            if worktree.exists():
                subprocess.run(
                    ["git", "worktree", "remove", "--force", str(worktree)],
                    cwd=self.config.project_root,
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )

    def _changed_paths(self, worktree: Path) -> list[str]:
        tracked = subprocess.run(
            ["git", "diff", "--name-only", "-z", "HEAD"],
            cwd=worktree,
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            cwd=worktree,
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
        return sorted(
            {path.decode() for path in (tracked + untracked).split(b"\0") if path}
        )

    def _discard(self, worktree: Path) -> None:
        if worktree.exists():
            subprocess.run(["git", "reset", "--hard"], cwd=worktree, check=False)
            subprocess.run(["git", "clean", "-fd"], cwd=worktree, check=False)

    def _reject_symlinks(self, worktree: Path, changed: list[str], role: str) -> None:
        for path in changed:
            if (worktree / path).is_symlink():
                raise BoundaryViolation(role, path)

    def _prompt(self, job: dict, registry: dict) -> str:
        roots = ", ".join(self.config.roles[job["role"]].writable_roots)
        return (
            f"You are the {job['role']} specialist for this product. Work only on this role. "
            f"You may create or modify only these roots: {roots}. Do not edit .silo or other roles. "
            "Use the following shared architecture as the authoritative cross-domain contract. "
            f"Architecture: {json.dumps(registry, separators=(',', ':'))}\nTask: {job['task']}"
        )
