from dataclasses import dataclass
from pathlib import PurePosixPath


class BoundaryViolation(ValueError):
    def __init__(self, role: str, path: str, owner: str | None = None):
        self.role = role
        self.path = path
        self.owner = owner
        super().__init__(f"{role} cannot modify {path}")


@dataclass(frozen=True)
class RolePolicy:
    name: str
    writable_roots: tuple[str, ...]
    model_provider: str | None = None
    model: str | None = None

    def owns(self, candidate: str) -> bool:
        path = _safe_path(candidate)
        return any(
            path == root or path.is_relative_to(root)
            for root in map(PurePosixPath, self.writable_roots)
        )

    def validate(self, paths: list[str], owners: dict[str, "RolePolicy"]) -> None:
        for candidate in paths:
            if self.owns(candidate):
                continue
            owner = next(
                (name for name, policy in owners.items() if policy.owns(candidate)),
                None,
            )
            raise BoundaryViolation(self.name, candidate, owner)


def _safe_path(candidate: str) -> PurePosixPath:
    path = PurePosixPath(candidate.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise BoundaryViolation("unknown", candidate)
    return path
