import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from silo.config import Config, token_hash
from silo.server import SiloServer


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        config_path = self.root / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "projectRoot": str(self.root / "project"),
                    "integrationBranch": "silo/integration",
                    "integrationChecks": [["true"]],
                    "adminTokenHash": token_hash("a" * 32),
                    "users": {
                        "alice": {
                            "role": "database",
                            "tokenHash": token_hash("u" * 32),
                        }
                    },
                    "roles": {
                        "database": {"writableRoots": ["db"]},
                        "auth": {"writableRoots": ["auth"]},
                    },
                }
            )
        )
        (self.root / "project").mkdir()
        environment = {
            "SILO_DATABASE": str(self.root / "silo.db"),
            "SILO_WORKTREES": str(self.root / "worktrees"),
        }
        with patch.dict(os.environ, environment), patch("silo.server.validate_runtime"):
            self.server = SiloServer(("127.0.0.1", 0), Config(config_path))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary_directory.cleanup()

    def request(self, path: str, token: str | None = None, body: dict | None = None):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers
        )
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        try:
            return response.status, json.loads(response.read())
        finally:
            response.close()

    def test_returns_assigned_role_for_authenticated_user(self):
        self.assertEqual(
            self.request("/v1/me", "u" * 32),
            (200, {"subject": "alice", "role": "database"}),
        )

    def test_rejects_unauthenticated_request(self):
        status, body = self.request("/v1/me")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "UNAUTHENTICATED")

    def test_rejects_job_for_another_specialist(self):
        status, body = self.request(
            "/v1/jobs", "u" * 32, {"role": "auth", "task": "change auth"}
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "ROLE_MISMATCH")


if __name__ == "__main__":
    unittest.main()
