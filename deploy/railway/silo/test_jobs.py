import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from silo.config import Config, token_hash
from silo.jobs import JobRunner
from silo.store import JobStore


class JobRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.git("init", "-b", "silo/integration")
        self.git("config", "user.email", "silo@example.invalid")
        self.git("config", "user.name", "SILO Test")
        (self.project / ".silo").mkdir()
        (self.project / "db").mkdir()
        (self.project / "auth").mkdir()
        (self.project / ".silo" / "architecture.json").write_text(
            json.dumps(
                {
                    "version": "1.0.0",
                    "product": {"name": "test", "purpose": "test product"},
                    "contracts": {
                        "apis": [],
                        "events": [],
                        "types": [],
                        "permissions": [],
                    },
                    "dependencies": [],
                }
            )
        )
        (self.project / "db" / "README.md").write_text("database\n")
        (self.project / "auth" / "README.md").write_text("auth\n")
        self.git("add", ".")
        self.git("commit", "-m", "initial")
        config_path = self.root / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "projectRoot": str(self.project),
                    "integrationBranch": "silo/integration",
                    "integrationChecks": [["git", "diff", "--check"]],
                    "adminTokenHash": token_hash("admin"),
                    "users": {
                        "alice": {
                            "role": "database",
                            "tokenHash": token_hash("user"),
                        }
                    },
                    "roles": {
                        "database": {"writableRoots": ["db"]},
                        "auth": {"writableRoots": ["auth"]},
                    },
                }
            )
        )
        self.config = Config(config_path)
        self.store = JobStore(self.root / "jobs.db")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def git(self, *args):
        subprocess.run(
            ["git", *args], cwd=self.project, check=True, capture_output=True
        )

    def run_job(self, script: str):
        with patch.dict(os.environ, {"SILO_WORKTREES": str(self.root / "worktrees")}):
            runner = JobRunner(self.config, self.store)
        architecture = (self.project / ".silo" / "architecture.json").read_bytes()
        job = {
            "id": "1" * 32,
            "subject": "alice",
            "role": "database",
            "task": "change database",
            "branch": "silo/database/test-job",
            "architectureDigest": hashlib.sha256(architecture).hexdigest(),
        }
        self.store.create(job)
        completed = subprocess.CompletedProcess(["codex"], 0)
        real_run = subprocess.run

        def fake_run(command, **kwargs):
            if command[0] == "codex":
                real_run(["sh", "-c", script], cwd=kwargs["cwd"], check=True)
                return completed
            return real_run(command, **kwargs)

        with patch("silo.jobs.subprocess.run", side_effect=fake_run):
            runner._run(job)
        return self.store.get(job["id"])

    def test_commits_owned_change(self):
        job = self.run_job("printf changed > db/result.sql")
        self.assertEqual(job["status"], "ready")
        self.assertEqual(job["changed_paths"], ["db/result.sql"])

    def test_rejects_cross_domain_change(self):
        job = self.run_job("mkdir -p auth; printf unsafe > auth/result.py")
        self.assertEqual(job["status"], "rejected")
        self.assertEqual(job["error_code"], "BOUNDARY_VIOLATION")

    def test_rejects_symlink_even_inside_owned_root(self):
        job = self.run_job("ln -s /etc/passwd db/system")
        self.assertEqual(job["status"], "rejected")
        self.assertEqual(job["error_code"], "BOUNDARY_VIOLATION")


if __name__ == "__main__":
    unittest.main()
