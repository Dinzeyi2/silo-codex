import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { ProviderConfig, ProvidersConfig, Role } from "./types.js";

const ENV_VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

/** Resolves `${ENV_VAR}` placeholders in a string against `env`. Leaves the literal text if unset. */
function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_VAR_RE, (match, name: string) => env[name] ?? match);
}

function resolveValue(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolateEnv(value, env);
  // An unresolved placeholder (the env var was never set) is treated as "not provided".
  return ENV_VAR_RE.test(resolved) ? undefined : resolved;
}

/**
 * Loads config/providers.yaml: per-role AI provider routing (baseUrl/apiKey/model).
 * Values may reference environment variables as `${VAR_NAME}`, resolved at load time,
 * so different roles can point at entirely different provider accounts/vendors without
 * secrets living in the YAML file itself.
 */
export function loadProvidersConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): ProvidersConfig {
  if (!existsSync(filePath)) return {};
  const doc = yaml.load(readFileSync(filePath, "utf8")) as { providers?: ProvidersConfig } | null;
  const raw = doc?.providers ?? {};
  const resolved: ProvidersConfig = {};
  for (const [role, cfg] of Object.entries(raw)) {
    resolved[role] = {
      baseUrl: resolveValue(cfg.baseUrl, env),
      apiKey: resolveValue(cfg.apiKey, env),
      model: resolveValue(cfg.model, env),
      modelReasoningEffort: cfg.modelReasoningEffort,
    };
  }
  return resolved;
}

/** Returns the provider config for a role, or an empty config (Codex CLI defaults apply). */
export function providerConfigForRole(role: Role, providers: ProvidersConfig): ProviderConfig {
  return providers[role] ?? {};
}
