import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from silo.config import Config, token_hash
from silo.integration import IntegrationError, Integrator
from silo.store import JobStore


class IntegratorTest(unittest.TestCase):
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
        self.architecture = self.project / ".silo" / "architecture.json"
        self.architecture.write_text(
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
        self.git("add", ".")
        self.git("commit", "-m", "initial")
        self.base_sha = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "silo/database/job")
        (self.project / "db" / "new.sql").write_text("SELECT 1;\n")
        self.git("add", ".")
        self.git("commit", "-m", "database job")
        self.job_sha = self.git("rev-parse", "HEAD")
        self.git("checkout", "silo/integration")
        self.store = JobStore(self.root / "jobs.db")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.project,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def config(self, integration_checks):
        path = self.root / "config.json"
        path.write_text(
            json.dumps(
                {
                    "projectRoot": str(self.project),
                    "integrationBranch": "silo/integration",
                    "integrationChecks": integration_checks,
                    "adminTokenHash": token_hash("a" * 32),
                    "users": {
                        "alice": {
                            "role": "database",
                            "tokenHash": token_hash("u" * 32),
                        }
                    },
                    "roles": {"database": {"writableRoots": ["db"]}},
                }
            )
        )
        return Config(path)

    def job(self):
        digest = hashlib.sha256(self.architecture.read_bytes()).hexdigest()
        job = {
            "id": "2" * 32,
            "subject": "alice",
            "role": "database",
            "task": "add query",
            "branch": "silo/database/job",
            "architectureDigest": digest,
        }
        self.store.create(job)
        self.store.update(job["id"], status="ready", commit_sha=self.job_sha)
        return self.store.get(job["id"])

    def test_validates_candidate_before_fast_forwarding_integration(self):
        result = Integrator(
            self.config([["test", "-f", "db/new.sql"]]), self.store
        ).integrate(self.job())
        self.assertEqual(result["status"], "integrated")
        self.assertEqual(self.git("show", "HEAD:db/new.sql"), "SELECT 1;")

    def test_failed_check_leaves_integration_branch_unchanged(self):
        with self.assertRaises(IntegrationError) as context:
            Integrator(self.config([["false"]]), self.store).integrate(self.job())
        self.assertEqual(context.exception.code, "INTEGRATION_CHECK_FAILED")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base_sha)
        self.assertEqual(self.store.get("2" * 32)["status"], "ready")


if __name__ == "__main__":
    unittest.main()
