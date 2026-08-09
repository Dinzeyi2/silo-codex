import { contractsReadableByRole } from "./registryLoader.js";
import type { Registry } from "./registryLoader.js";
import type { Role } from "./types.js";

/**
 * Builds the context preamble sent to a specialist's model before the task prompt itself.
 * This is what gives the agent "shared architectural awareness" without giving it any other
 * domain's implementation files: the product spec (what's being built), this role's place in
 * it, and the *contracts* (not source) of the domains it depends on or is depended on by.
 */
export function buildRoleContext(role: Role, registry: Registry): string {
  const sections: string[] = [];

  sections.push(
    [
      "# SILO specialist context",
      "",
      `You are the **${role}** specialist agent. You may create or modify files only under your`,
      "owned paths in this working directory. Any other domain's implementation is intentionally",
      "not present in this checkout — do not attempt to invent, guess, or recreate it. If a task",
      "requires a change to another domain's implementation, do not make it: describe what you",
      "need from that domain in your final response instead.",
      "",
      "The `architecture/` directory in this working directory is the shared, versioned contract",
      "registry. It is read-only context: build against it, but never edit files under it.",
    ].join("\n"),
  );

  const product = registry.product;
  if (product && Object.keys(product).length > 0) {
    sections.push(["## Product", "", "```yaml", yamlLikeDump(product), "```"].join("\n"));
  }

  const domain = registry.domains[role];
  if (domain) {
    const lines = ["## Your domain", ""];
    if (domain.description) lines.push(domain.description, "");
    if (domain.dependsOn?.length) lines.push(`Depends on: ${domain.dependsOn.join(", ")}`);
    if (domain.exposes?.length) lines.push(`Exposes contracts: ${domain.exposes.join(", ")}`);
    sections.push(lines.join("\n"));
  }

  const readableContractIds = contractsReadableByRole(role, registry);
  if (readableContractIds.length > 0) {
    const lines = ["## Contracts relevant to you", ""];
    for (const id of readableContractIds) {
      const contract = registry.contracts[id];
      if (!contract) continue;
      lines.push(`- \`${id}\` (${contract.kind}) — see \`${contract.relPath}\` in this checkout.`);
    }
    sections.push(lines.join("\n"));
  }

  sections.push(
    [
      "## Other domains",
      "",
      Object.entries(registry.domains)
        .filter(([name]) => name !== role)
        .map(([name, def]) => `- **${name}**: ${def.description ?? "(no description)"}`)
        .join("\n"),
    ].join("\n"),
  );

  return sections.join("\n\n");
}

/** Minimal, dependency-free YAML-ish dump for embedding plain config objects in a prompt. */
function yamlLikeDump(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((v) => `${pad}- ${yamlLikeDump(v, indent + 1).trim()}`).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        if (v && typeof v === "object") {
          return `${pad}${k}:\n${yamlLikeDump(v, indent + 1)}`;
        }
        return `${pad}${k}: ${String(v)}`;
      })
      .join("\n");
  }
  return `${pad}${String(value)}`;
}
