import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export type ContractKind = "api" | "event" | "type";

export type Contract = {
  id: string;
  kind: ContractKind;
  relPath: string;
  content: unknown;
};

export type DomainDef = {
  description?: string;
  dependsOn?: string[];
  exposes?: string[];
};

export type PermissionDef = {
  canRead?: string[];
};

export type DependencyEdge = {
  from: string;
  to: string;
  via?: string;
};

export type VersionsLock = {
  version: string;
  updatedAt?: string;
  contentHash?: string;
};

/** The fully-loaded shared architecture registry: the contract map every specialist builds against. */
export type Registry = {
  rootDir: string;
  product: Record<string, unknown>;
  domains: Record<string, DomainDef>;
  permissions: Record<string, PermissionDef>;
  dependencies: DependencyEdge[];
  versionsLock: VersionsLock;
  contracts: Record<string, Contract>;
};

function readYaml(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  return yaml.load(raw);
}

function readJson(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function listFiles(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extensions.some((ext) => f.endsWith(ext)))
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort();
}

/** Reads the registry directory tree off disk into a structured Registry object. Does not validate it. */
export function loadRegistry(rootDir: string): Registry {
  const productPath = path.join(rootDir, "product.yaml");
  const domainsPath = path.join(rootDir, "domains.yaml");
  const permissionsPath = path.join(rootDir, "permissions.yaml");
  const dependenciesPath = path.join(rootDir, "dependencies.yaml");
  const versionsLockPath = path.join(rootDir, "versions.lock");

  const product = (existsSync(productPath) ? readYaml(productPath) : {}) as Record<string, unknown>;
  const domainsDoc = (existsSync(domainsPath) ? readYaml(domainsPath) : {}) as {
    domains?: Record<string, DomainDef>;
  };
  const permissionsDoc = (existsSync(permissionsPath) ? readYaml(permissionsPath) : {}) as {
    permissions?: Record<string, PermissionDef>;
  };
  const dependenciesDoc = (existsSync(dependenciesPath) ? readYaml(dependenciesPath) : {}) as {
    dependencies?: DependencyEdge[];
  };
  const versionsLock = (
    existsSync(versionsLockPath) ? readYaml(versionsLockPath) : { version: "0.0.0" }
  ) as VersionsLock;

  const contracts: Record<string, Contract> = {};

  const apiDir = path.join(rootDir, "api");
  for (const file of listFiles(apiDir, [".yaml", ".yml"])) {
    const relPath = path.posix.join("architecture", "api", file);
    const id = `api:${file.replace(/\.openapi\.(yaml|yml)$|\.(yaml|yml)$/, "")}`;
    contracts[id] = { id, kind: "api", relPath, content: readYaml(path.join(apiDir, file)) };
  }

  const eventsDir = path.join(rootDir, "events");
  for (const file of listFiles(eventsDir, [".json"])) {
    const relPath = path.posix.join("architecture", "events", file);
    const id = `event:${file.replace(/\.schema\.json$|\.json$/, "")}`;
    contracts[id] = { id, kind: "event", relPath, content: readJson(path.join(eventsDir, file)) };
  }

  const typesDir = path.join(rootDir, "types");
  for (const file of listFiles(typesDir, [".json"])) {
    const relPath = path.posix.join("architecture", "types", file);
    const id = `type:${file.replace(/\.schema\.json$|\.json$/, "")}`;
    contracts[id] = { id, kind: "type", relPath, content: readJson(path.join(typesDir, file)) };
  }

  return {
    rootDir,
    product,
    domains: domainsDoc.domains ?? {},
    permissions: permissionsDoc.permissions ?? {},
    dependencies: dependenciesDoc.dependencies ?? [],
    versionsLock,
    contracts,
  };
}

/**
 * Computes a deterministic content hash of the whole registry (independent of load order),
 * used to detect drift between the version a task was started against and the current one.
 */
export function computeRegistryHash(registry: Registry): string {
  const hash = createHash("sha256");
  hash.update(`product:${stableStringify(registry.product)}\n`);
  hash.update(`domains:${stableStringify(registry.domains)}\n`);
  hash.update(`permissions:${stableStringify(registry.permissions)}\n`);
  hash.update(`dependencies:${stableStringify(registry.dependencies)}\n`);
  for (const id of Object.keys(registry.contracts).sort()) {
    hash.update(`contract:${id}:${stableStringify(registry.contracts[id]!.content)}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Returns the contract ids a role is permitted to read, per permissions.yaml, plus its own domain's exposes. */
export function contractsReadableByRole(role: string, registry: Registry): string[] {
  const own = registry.domains[role]?.exposes ?? [];
  const granted = registry.permissions[role]?.canRead ?? [];
  return Array.from(new Set([...own, ...granted]));
}
