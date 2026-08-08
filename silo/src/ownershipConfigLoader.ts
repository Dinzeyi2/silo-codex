import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { validateOwnershipConfig } from "./ownership.js";
import { RegistryValidationError } from "./types.js";
import type { OwnershipConfig } from "./types.js";

/** Loads config/ownership.yaml — the source of truth for which paths each role may write to. */
export function loadOwnershipConfig(filePath: string): OwnershipConfig {
  const doc = yaml.load(readFileSync(filePath, "utf8")) as OwnershipConfig | null;
  if (!doc || !doc.roles) {
    throw new RegistryValidationError([`${filePath} does not define a 'roles' map`]);
  }
  return doc;
}

/** Loads and validates config/ownership.yaml, throwing if roles overlap or are misconfigured. */
export function loadAndValidateOwnershipConfig(filePath: string): OwnershipConfig {
  const config = loadOwnershipConfig(filePath);
  const issues = validateOwnershipConfig(config);
  if (issues.length > 0) {
    throw new RegistryValidationError(issues);
  }
  return config;
}
