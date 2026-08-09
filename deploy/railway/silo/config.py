import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from .policy import RolePolicy


@dataclass(frozen=True)
class Principal:
    subject: str
    role: str


class Config:
    def __init__(self, path: Path):
        raw = json.loads(path.read_text())
        self.project_root = Path(
            raw.get("projectRoot", "/data/workspace/project")
        ).resolve()
        self.integration_branch = raw.get("integrationBranch", "silo/integration")
        self.integration_checks = raw.get("integrationChecks", [])
        self.roles = {
            name: RolePolicy(
                name,
                tuple(value["writableRoots"]),
                value.get("modelProvider"),
                value.get("model"),
            )
            for name, value in raw["roles"].items()
        }
        self.users = raw["users"]
        self.admin_token_hash = raw["adminTokenHash"]
        self.max_task_bytes = int(raw.get("maxTaskBytes", 32_768))
        self.max_architecture_bytes = int(raw.get("maxArchitectureBytes", 32_768))
        self.job_timeout_seconds = int(raw.get("jobTimeoutSeconds", 1800))
        self.max_concurrent_jobs = int(raw.get("maxConcurrentJobs", 2))
        self._validate()

    def _validate(self) -> None:
        if not self.roles:
            raise ValueError("at least one role is required")
        if self.max_concurrent_jobs < 1:
            raise ValueError("maxConcurrentJobs must be positive")
        if not valid_token_hash(self.admin_token_hash):
            raise ValueError("adminTokenHash is not a SILO scrypt token hash")
        if not self.integration_checks or any(
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) for part in command)
            for command in self.integration_checks
        ):
            raise ValueError("at least one argv-style integration check is required")
        for subject, user in self.users.items():
            if user["role"] not in self.roles:
                raise ValueError(
                    f"user {subject} references unknown role {user['role']}"
                )
            if not valid_token_hash(user.get("tokenHash", "")):
                raise ValueError(f"user {subject} has an invalid token hash")
        roots = [
            (role, root)
            for role, policy in self.roles.items()
            for root in policy.writable_roots
        ]
        for index, (role, root) in enumerate(roots):
            if (
                not root
                or root.startswith("/")
                or ".." in Path(root).parts
                or root == ".silo"
            ):
                raise ValueError(f"role {role} has unsafe writable root {root}")
            for other_role, other_root in roots[index + 1 :]:
                if (
                    Path(root) == Path(other_root)
                    or Path(root).is_relative_to(other_root)
                    or Path(other_root).is_relative_to(root)
                ):
                    raise ValueError(
                        f"writable roots overlap for {role} and {other_role}"
                    )

    def authenticate(self, token: str) -> Principal | None:
        for subject, user in self.users.items():
            if verify_token(token, user["tokenHash"]):
                return Principal(subject, user["role"])
        return None

    def is_admin(self, token: str) -> bool:
        return verify_token(token, self.admin_token_hash)


def token_hash(token: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(token.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt:{salt.hex()}:{digest.hex()}"


def verify_token(token: str, encoded: str) -> bool:
    try:
        algorithm, salt_hex, expected = encoded.split(":", 2)
        if algorithm != "scrypt":
            return False
        actual = token_hash(token, bytes.fromhex(salt_hex)).rsplit(":", 1)[1]
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def valid_token_hash(encoded: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = encoded.split(":", 2)
        return (
            algorithm == "scrypt"
            and len(bytes.fromhex(salt_hex)) == 16
            and len(bytes.fromhex(digest_hex)) == 32
        )
    except (ValueError, TypeError):
        return False


def load_config() -> Config:
    return Config(Path(os.environ.get("SILO_CONFIG", "/data/silo/config.json")))
