#!/usr/bin/env node
import path from "node:path";
import { loadSiloConfig } from "./pipeline.js";
import { runTask } from "./pipeline.js";
import { startServer } from "./server.js";

type Flags = Record<string, string>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function resolveConfigPaths(flags: Flags) {
  const repo = path.resolve(flags.repo ?? process.cwd());
  const configDir = path.resolve(flags["config-dir"] ?? path.join(repo, "silo", "config"));
  const registryDir = path.resolve(flags["registry-dir"] ?? path.join(repo, "architecture"));
  return {
    integrationRepoPath: repo,
    ownershipPath: path.join(configDir, "ownership.yaml"),
    membersPath: path.join(configDir, "members.yaml"),
    providersPath: path.join(configDir, "providers.yaml"),
    registryPath: registryDir,
    baseBranch: flags["base-branch"],
  };
}

function printHelp(): void {
  console.log(`SILO — role-scoped multi-agent orchestrator for Codex

Usage:
  silo run --member <id> --role <role> --prompt "<task>" [--repo <path>] [--task-id <id>]
  silo serve [--port 8787] [--repo <path>]
  silo --help

Config is read from <repo>/silo/config/{ownership,members,providers}.yaml and
<repo>/architecture/ (the shared architecture registry) unless --config-dir /
--registry-dir override them.`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);

  if (!command || flags.help === "true" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "run") {
    if (!flags.member || !flags.role || !flags.prompt) {
      console.error("Error: --member, --role, and --prompt are required.");
      process.exitCode = 1;
      return;
    }
    const config = loadSiloConfig(resolveConfigPaths(flags));
    const result = await runTask(config, {
      memberId: flags.member,
      role: flags.role,
      prompt: flags.prompt,
      taskId: flags["task-id"],
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.violations.length > 0) process.exitCode = 2;
    return;
  }

  if (command === "serve") {
    const config = loadSiloConfig(resolveConfigPaths(flags));
    startServer(config, flags.port ? Number(flags.port) : undefined);
    return;
  }

  console.error(`Unknown command: '${command}'`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
