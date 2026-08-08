# SILO

SILO is a role-scoped multi-agent orchestrator built on top of [Codex](https://github.com/openai/codex).
Instead of one Codex agent with access to a whole repository, SILO gives every project member
exactly one specialist role — `database`, `auth`, `frontend`, `billing`, `intelligence`,
`infrastructure` (or any set you define) — and enforces, at the platform level, that:

1. **A member can only invoke the specialist they're assigned to.** The API checks
   `member.role == requested role` before any model is called — a database member cannot invoke
   the auth specialist by asking nicely in a prompt.
2. **A specialist can only write to its own domain.** `db/`, `auth/`, `ui/`, `billing/`, … are
   fixed, non-overlapping path roots per role. A change outside that role's roots is rejected as
   a `BOUNDARY_VIOLATION` — checked against the real `git diff`, not against what the model
   claims it did.
3. **A specialist never even sees another domain's implementation.** Each task runs in a `git`
   worktree that's sparse-checked-out to _only_ that role's owned paths, so "the model receives
   only files from its domain" is a filesystem fact, not a prompt instruction.
4. **Every specialist still shares one architectural picture.** A versioned registry under
   `architecture/` (product spec, domain map, permissions, dependencies, OpenAPI/JSON-Schema
   contracts) is checked out into every worktree read-only, so specialists connect through
   agreed contracts instead of inventing incompatible ones. No role — including the one that
   "owns" a contract file — can write into `architecture/`; it changes through review, not
   through a task.
5. **Different roles can use different AI providers.** Base URL, API key, and model are resolved
   per role, so e.g. the database and auth specialists don't have to share a vendor or account.
6. **Work integrates through review, not trust.** Each task is a branch (`silo/<role>/<taskId>`)
   in an isolated worktree. It's committed, diffed against the ownership registry, and only
   merged into the shared integration branch if the diff is clean. A violation is never
   cherry-picked around — the whole change is rejected, and the branch is kept (not deleted) so
   it can be audited.

## How it fits together

```
        member + role                         real, boundary-enforced merge
              │                                              │
              ▼                                              ▼
     ┌─────────────────┐   git worktree,   ┌───────────┐   git diff + ownership   ┌─────────────────────┐
     │  SILO pipeline   │──sparse-checked ─▶│  Codex     │──check, then merge ────▶│ integration branch  │
     │ (authz, registry,│   out to owned    │  agent     │   (or reject + keep      │  (the real product) │
     │  provider routing)│  paths + registry│  (per role)│    branch for audit)     │                      │
     └─────────────────┘                    └───────────┘                          └─────────────────────┘
```

## Package layout

```
silo/
  src/                   the orchestrator itself (see module docs below)
  config/                reference ownership/members/providers config — copy & customize per project
  examples/sample-project/  a runnable target project: architecture/ + db/, auth/, ui/, ... + silo/config/
  tests/                  unit + real-git integration tests (no network / real LLM calls required)
```

`config/` here is a _template_. A real deployment's `silo/config/{ownership,members,providers}.yaml`
and `architecture/` live **inside the target/product repository** SILO is orchestrating — see
`examples/sample-project/` for what that looks like end to end.

### Source modules

| Module                                       | Responsibility                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownership.ts`                               | Path → role classification and `BOUNDARY_VIOLATION` checks. Pure functions, no I/O.                                                                                                                     |
| `registryLoader.ts` / `registryValidator.ts` | Load `architecture/*` off disk and validate it's internally consistent (no dangling contract references, valid OpenAPI/JSON-Schema, semver `versions.lock`).                                            |
| `members.ts`                                 | The memberId → role directory and the `authorize()` check (`RoleMismatchError`, `UnknownMemberError`, `UnknownRoleError`).                                                                              |
| `providerConfig.ts`                          | Per-role AI provider routing, with `${ENV_VAR}` resolution.                                                                                                                                             |
| `worktreeManager.ts`                         | Creates/removes a `git worktree` per task, sparse-checked-out to the role's owned paths + `architecture/`.                                                                                              |
| `promptBuilder.ts`                           | Builds the shared-context preamble (product spec, this role's place in it, contracts it may read) sent before the task prompt.                                                                          |
| `codexRunner.ts`                             | Runs one specialist turn via `@openai/codex-sdk`, scoped to the worktree, `workspace-write` sandboxed, using the role's provider.                                                                       |
| `diffValidator.ts`                           | Commits the worktree's changes and checks the resulting diff against ownership boundaries.                                                                                                              |
| `mergePipeline.ts`                           | Commits + validates + merges (`git merge --no-ff`) into the integration branch; serialized per repo via `asyncLock.ts`.                                                                                 |
| `pipeline.ts`                                | Wires all of the above into `runTask()` — the end-to-end flow for one specialist task — plus `runProjectTask()` for multi-project (cloud) mode.                                                         |
| `server.ts`                                  | Single-repo HTTP API (`POST /v1/tasks`, `GET /v1/architecture`, `GET /v1/roles`, `GET /healthz`).                                                                                                       |
| `projects.ts`                                | File-backed multi-project registry (`ProjectStore`): id, repo URL, GitHub token, base branch.                                                                                                           |
| `repoManager.ts`                             | Clones/syncs a project's repo onto local disk and pushes a merged base branch back to GitHub, authenticating per-request via `git.ts`'s `gitAuthed` (a token header, never persisted to `.git/config`). |
| `serviceAuth.ts`                             | Validates `SILO_SERVICE_TOKEN` at boot and checks `Authorization: Bearer` on every cloud-mode request.                                                                                                  |
| `cloudServer.ts`                             | Multi-project, hosted HTTP API (`POST /v1/projects`, `POST /v1/projects/:id/tasks`, …) — what `silo cloud` runs. See `DEPLOY.md`.                                                                       |
| `cli.ts`                                     | `silo run` / `silo serve` (single repo, local/dev) and `silo cloud` (multi-project, hosted).                                                                                                            |

## Quick start

```bash
# from the silo/ package
pnpm install
pnpm run build

# run one task as a member, against a target repo (defaults to CWD)
node dist/cli.js run \
  --repo ./examples/sample-project \
  --member alice \
  --role database \
  --prompt "Add a users table with an email column."

# or run the HTTP API
node dist/cli.js serve --repo ./examples/sample-project --port 8787
```

`silo run` reads config from `<repo>/silo/config/{ownership,members,providers}.yaml` and the
shared registry from `<repo>/architecture/` unless you pass `--config-dir` / `--registry-dir`.
It exits `0` on a clean merge, `2` if the task ran but was rejected for a boundary violation, and
`1` on an authorization or configuration error.

### HTTP API

```
GET  /healthz                → { status: "ok" }
GET  /v1/roles                → the ownership registry
GET  /v1/architecture         → the loaded product spec, domains, permissions, dependencies, contracts
POST /v1/tasks                → { memberId, role, prompt, taskId? } → runs one specialist task
```

`POST /v1/tasks` responds `200` on a clean merge, `409` with a `violations` array on a boundary
violation, `403 ROLE_MISMATCH` / `404 UNKNOWN_MEMBER` / `400 UNKNOWN_ROLE` on an authorization
failure, and `400` on a malformed request.

## Cloud / hosted mode (multi-project)

The above is single-repo, local/dev mode. For a hosted service your own backend calls — many
projects, each its own GitHub repo, deployable on Railway — use `silo cloud` instead:

```bash
SILO_SERVICE_TOKEN=$(openssl rand -hex 32) SILO_DATA_DIR=./data node dist/cli.js cloud
```

Every route except `/healthz` requires `Authorization: Bearer $SILO_SERVICE_TOKEN`. Register a
project (SILO clones it on first use and pushes a clean merge back to it):

```
POST /v1/projects          { id, name, repoUrl, githubToken, baseBranch? }
GET  /v1/projects
POST /v1/projects/:id/tasks       { memberId, role, prompt, taskId? }
GET  /v1/projects/:id/architecture
GET  /v1/projects/:id/roles
```

This is meant to be called **server-to-server from your own backend**, which has already
authenticated the end user and knows their `memberId` — never expose `SILO_SERVICE_TOKEN` to a
browser. See **[`DEPLOY.md`](./DEPLOY.md)** for the full Railway setup (Dockerfile path, volume,
env vars) and `silo/deploy/Dockerfile` for how the `codex` binary is built from this repo's own
`codex-rs/` source rather than resolved from an npm package.

## Setting SILO up for your own project

1. Decide your roles and their owned path roots; write `<repo>/silo/config/ownership.yaml`.
   Roots must not overlap and none may live under `architecture/` — that's reserved for the
   shared registry (`ownership.ts` enforces both at load time).
2. Write `<repo>/architecture/{product,domains,permissions,dependencies}.yaml` and
   `versions.lock`, plus your OpenAPI/JSON-Schema contracts under `architecture/{api,events,types}/`.
   `domains.yaml` needs exactly one entry per role in `ownership.yaml` — this cross-check runs
   before any task is accepted (`registryValidator.ts`).
3. Write `<repo>/silo/config/members.yaml` (who is assigned which role) and
   `<repo>/silo/config/providers.yaml` (which AI provider/model each role uses, via `${ENV_VAR}`
   references resolved from the process environment — never commit real keys to the YAML).
4. Point `silo serve`/`silo run` at that repo with `--repo`.

## What SILO does _not_ claim

This is boundary enforcement and contract-sharing, not a cryptographic guarantee. The product
spec and the contracts a role is granted read access to are still sent to that role's configured
AI provider — SILO does not promise a provider learns nothing. What it does guarantee, mechanically
(not just by prompt instruction), is: a specialist's model only ever sees its own domain's files
plus the shared registry, and a specialist's change never reaches the integration branch unless
every changed path is inside that specialist's owned roots.

## Known limitations / extension points

- **Contract-vs-implementation drift isn't checked yet.** SILO validates that the registry
  itself is well-formed and cross-referenced, but it does not currently verify that, say, the
  auth domain's actual implementation matches `architecture/api/auth.openapi.yaml`. Wiring in
  consumer-driven contract tests per domain is the natural next step (`mergePipeline.ts` is the
  hook point).
- **Registry changes go through the same filesystem boundary as everything else** (no role can
  write to `architecture/`), but there's no built-in contract-change-proposal workflow yet (see
  the "How I understand the workflow" design notes this package's tests encode — proposals would
  be a small addition on top of `registryValidator.ts` + a review step before bumping
  `versions.lock`).
- **Merges are serialized per repo** (`asyncLock.ts`) so concurrent tasks can't corrupt the
  integration repo's git state, but there's no cross-process/multi-replica locking — running
  multiple `silo cloud`/`silo serve` processes against the same repo needs an external lock
  (e.g. an advisory DB lock) added around `mergePipeline.ts` / `repoManager.ts`.
- **Shared/root-level files** (lockfiles, CI config, workspace manifests) aren't modeled with a
  distinct ownership category yet — see the design notes for `integration-owned` /
  `generated-only` categories as a future addition to `ownership.ts`.
- **Cloud mode's project store is a single JSON file** (`projects.ts`) — fine for one instance
  backed by a persistent volume, not for multiple replicas or high write concurrency on project
  registration itself (task execution is safe; see the DB lock note above).
- **All projects on one `silo cloud` deployment share one process environment** for `${VAR}`
  resolution in each project's `providers.yaml` — see DEPLOY.md for how to namespace variable
  names per project if that's not acceptable for your setup.
