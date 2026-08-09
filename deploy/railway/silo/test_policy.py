import json
import tempfile
import unittest
from pathlib import Path

from silo.config import Config, token_hash, verify_token
from silo.policy import BoundaryViolation, RolePolicy
from silo.registry import ArchitectureRegistry
from silo.store import JobStore


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.database = RolePolicy("database", ("db", "migrations", "schema"))
        self.auth = RolePolicy("auth", ("auth", "security"))
        self.roles = {"database": self.database, "auth": self.auth}

    def test_accepts_every_owned_path(self):
        self.database.validate(
            ["db/users.sql", "migrations/001.sql", "schema"], self.roles
        )

    def test_reports_owner_for_cross_domain_change(self):
        with self.assertRaises(BoundaryViolation) as context:
            self.auth.validate(["db/users.sql"], self.roles)
        self.assertEqual(
            (context.exception.role, context.exception.path, context.exception.owner),
            ("auth", "db/users.sql", "database"),
        )

    def test_rejects_parent_traversal(self):
        with self.assertRaises(BoundaryViolation):
            self.database.validate(["db/../../auth/keys.py"], self.roles)


class ConfigTest(unittest.TestCase):
    def test_authenticates_user_and_admin_without_storing_raw_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "projectRoot": directory,
                        "integrationChecks": [["git", "diff", "--check"]],
                        "adminTokenHash": token_hash("admin-secret"),
                        "users": {
                            "alice": {
                                "role": "database",
                                "tokenHash": token_hash("user-secret"),
                            }
                        },
                        "roles": {"database": {"writableRoots": ["db"]}},
                    }
                )
            )
            config = Config(path)
            self.assertEqual(config.authenticate("user-secret").role, "database")
            self.assertIsNone(config.authenticate("wrong"))
            self.assertTrue(config.is_admin("admin-secret"))

    def test_scrypt_hash_uses_random_salt(self):
        first = token_hash("secret")
        second = token_hash("secret")
        self.assertNotEqual(first, second)
        self.assertTrue(verify_token("secret", first))
        self.assertFalse(verify_token("wrong", first))


class RegistryTest(unittest.TestCase):
    def test_loads_versioned_contract_and_adds_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".silo").mkdir()
            (root / ".silo" / "architecture.json").write_text(
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
            registry = ArchitectureRegistry(root).load()
            self.assertEqual(
                set(registry),
                {"version", "product", "contracts", "dependencies", "digest"},
            )


class StoreTest(unittest.TestCase):
    def test_marks_interrupted_job_failed_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            store = JobStore(Path(directory) / "silo.db")
            store.create(
                {
                    "id": "3" * 32,
                    "subject": "alice",
                    "role": "database",
                    "task": "work",
                    "branch": "silo/database/job",
                    "architectureDigest": "digest",
                }
            )
            store.update("3" * 32, status="running")
            store.fail_interrupted()
            job = store.get("3" * 32)
            self.assertEqual(job["status"], "failed")
            self.assertEqual(job["error_code"], "PROCESS_RESTARTED")


if __name__ == "__main__":
    unittest.main()
