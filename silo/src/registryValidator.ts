import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { OwnershipConfig } from "./types.js";
import type { Registry } from "./registryLoader.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Validates a loaded registry for internal consistency: every specialist must build against
 * the *same* set of contracts, so dangling references or malformed schemas here would let
 * roles silently invent incompatible interfaces — which is exactly what the registry exists
 * to prevent. Returns a list of human-readable issues; empty means the registry is valid.
 */
export function validateRegistry(registry: Registry, ownership?: OwnershipConfig): string[] {
  const issues: string[] = [];
  // A fresh Ajv instance per call: Ajv registers schemas globally by their `$id`, and our
  // event/type contracts use stable ids like "type:user" — reusing one Ajv instance across
  // calls (e.g. re-validating after a registry edit) would throw "schema ... already exists"
  // on the second call instead of actually validating anything.
  const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));

  // --- product.yaml -------------------------------------------------------
  if (!registry.product || Object.keys(registry.product).length === 0) {
    issues.push("product.yaml is missing or empty — every specialist needs shared product context");
  } else {
    for (const field of ["name", "description"]) {
      if (!(field in registry.product)) {
        issues.push(`product.yaml is missing required field '${field}'`);
      }
    }
  }

  // --- domains.yaml --------------------------------------------------------
  const domainNames = new Set(Object.keys(registry.domains));
  if (domainNames.size === 0) {
    issues.push("domains.yaml declares no domains");
  }
  if (ownership) {
    const roleNames = new Set(Object.keys(ownership.roles));
    for (const domain of domainNames) {
      if (!roleNames.has(domain)) {
        issues.push(
          `domains.yaml declares domain '${domain}' which has no matching role in ownership config`,
        );
      }
    }
    for (const role of roleNames) {
      if (!domainNames.has(role)) {
        issues.push(`role '${role}' in ownership config has no entry in domains.yaml`);
      }
    }
  }
  for (const [domain, def] of Object.entries(registry.domains)) {
    for (const dep of def.dependsOn ?? []) {
      if (!domainNames.has(dep)) {
        issues.push(`domains.yaml: domain '${domain}' depends on unknown domain '${dep}'`);
      }
      if (dep === domain) {
        issues.push(`domains.yaml: domain '${domain}' cannot depend on itself`);
      }
    }
    for (const contractId of def.exposes ?? []) {
      if (!(contractId in registry.contracts)) {
        issues.push(`domains.yaml: domain '${domain}' exposes unknown contract '${contractId}'`);
      }
    }
  }

  // --- permissions.yaml ------------------------------------------------------
  for (const [role, def] of Object.entries(registry.permissions)) {
    if (!domainNames.has(role)) {
      issues.push(`permissions.yaml: role '${role}' has no entry in domains.yaml`);
    }
    for (const contractId of def.canRead ?? []) {
      if (!(contractId in registry.contracts)) {
        issues.push(
          `permissions.yaml: role '${role}' is granted read access to unknown contract '${contractId}'`,
        );
      }
    }
  }

  // --- dependencies.yaml -------------------------------------------------
  for (const [i, edge] of registry.dependencies.entries()) {
    if (!domainNames.has(edge.from)) {
      issues.push(`dependencies.yaml[${i}]: unknown source domain '${edge.from}'`);
    }
    if (!domainNames.has(edge.to)) {
      issues.push(`dependencies.yaml[${i}]: unknown target domain '${edge.to}'`);
    }
    if (edge.via && !(edge.via in registry.contracts)) {
      issues.push(`dependencies.yaml[${i}]: references unknown contract '${edge.via}'`);
    }
  }

  // --- versions.lock -------------------------------------------------------
  if (!registry.versionsLock?.version) {
    issues.push("versions.lock is missing a 'version' field");
  } else if (!SEMVER_RE.test(registry.versionsLock.version)) {
    issues.push(`versions.lock 'version' (${registry.versionsLock.version}) is not valid semver (x.y.z)`);
  }

  // --- contracts: structural well-formedness -----------------------------
  for (const [id, contract] of Object.entries(registry.contracts)) {
    if (contract.kind === "api") {
      const doc = contract.content as Record<string, unknown> | null;
      if (!doc || typeof doc !== "object") {
        issues.push(`contract '${id}' (${contract.relPath}) is not a valid document`);
        continue;
      }
      if (!doc.openapi)
        issues.push(`contract '${id}' (${contract.relPath}) is missing 'openapi' version field`);
      if (!doc.info) issues.push(`contract '${id}' (${contract.relPath}) is missing 'info'`);
      if (!doc.paths || Object.keys(doc.paths as object).length === 0) {
        issues.push(`contract '${id}' (${contract.relPath}) declares no paths`);
      }
    } else {
      // event / type contracts must be well-formed JSON Schema documents.
      try {
        ajv.compile(contract.content as object);
      } catch (err) {
        issues.push(
          `contract '${id}' (${contract.relPath}) is not a valid JSON Schema: ${(err as Error).message}`,
        );
      }
    }
  }

  return issues;
}
