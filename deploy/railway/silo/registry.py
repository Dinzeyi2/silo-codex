import hashlib
import json
import re
from pathlib import Path


class ArchitectureRegistry:
    def __init__(self, project_root: Path, max_bytes: int = 32_768):
        self.path = project_root / ".silo" / "architecture.json"
        self.max_bytes = max_bytes

    def load(self) -> dict:
        raw = self.path.read_bytes()
        if len(raw) > self.max_bytes:
            raise ValueError("architecture registry exceeds the configured size limit")
        value = json.loads(raw)
        required = {"version", "product", "contracts", "dependencies"}
        missing = sorted(required - value.keys())
        if missing:
            raise ValueError(f"architecture registry is missing: {', '.join(missing)}")
        self._validate(value)
        value["digest"] = self.digest()
        return value

    def digest(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest()

    @staticmethod
    def validate_owners(value: dict, roles: set[str]) -> None:
        for entries in value["contracts"].values():
            for entry in entries:
                if entry["owner"] not in roles:
                    raise ValueError(
                        f"contract {entry['id']} references unknown role {entry['owner']}"
                    )
        for dependency in value["dependencies"]:
            for endpoint in ("from", "to"):
                if dependency[endpoint] not in roles:
                    raise ValueError(
                        f"dependency references unknown role {dependency[endpoint]}"
                    )

    def _validate(self, value: dict) -> None:
        if not re.fullmatch(r"\d+\.\d+\.\d+", value["version"]):
            raise ValueError("architecture version must be semantic x.y.z")
        product = value["product"]
        if not isinstance(product, dict) or not all(
            isinstance(product.get(field), str) and product[field].strip()
            for field in ("name", "purpose")
        ):
            raise ValueError("product requires non-empty name and purpose")
        contracts = value["contracts"]
        if not isinstance(contracts, dict):
            raise ValueError("contracts must be an object")
        contract_kinds = {"apis", "events", "types", "permissions"}
        if set(contracts) != contract_kinds:
            raise ValueError(
                "contracts must define only APIs, events, types, and permissions"
            )
        identifiers = set()
        for kind in contract_kinds:
            entries = contracts.get(kind)
            if not isinstance(entries, list):
                raise ValueError(f"contracts.{kind} must be a list")
            for entry in entries:
                required = ("id", "version", "owner", "definition")
                if not isinstance(entry, dict) or any(
                    field not in entry for field in required
                ):
                    raise ValueError(
                        f"every {kind} contract requires {', '.join(required)}"
                    )
                identifier = entry["id"]
                if not isinstance(identifier, str) or identifier in identifiers:
                    raise ValueError(
                        f"contract id must be a unique string: {identifier}"
                    )
                if not isinstance(entry["version"], str) or not re.fullmatch(
                    r"\d+\.\d+\.\d+", entry["version"]
                ):
                    raise ValueError(f"contract {identifier} has an invalid version")
                if not isinstance(entry["owner"], str) or not entry["owner"]:
                    raise ValueError(f"contract {identifier} requires an owner")
                if not isinstance(entry["definition"], dict):
                    raise ValueError(
                        f"contract {identifier} definition must be an object"
                    )
                identifiers.add(identifier)
        dependencies = value["dependencies"]
        if not isinstance(dependencies, list):
            raise ValueError("dependencies must be a list")
        for dependency in dependencies:
            if not isinstance(dependency, dict) or any(
                field not in dependency for field in ("from", "to", "contracts")
            ):
                raise ValueError("dependencies require from, to, and contracts")
            if not isinstance(dependency["contracts"], list) or any(
                contract not in identifiers for contract in dependency["contracts"]
            ):
                raise ValueError("dependency references an unknown contract")
