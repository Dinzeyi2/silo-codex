# Run SILO on Railway

This deployment runs **SILO**, a role-scoped Codex agent orchestrator. SILO
gives each project member one specialist role,
restricts the specialist's checkout and accepted diff to role-owned paths, and
coordinates specialists through a shared, versioned architecture registry.

SILO is not a zero-knowledge system. Its security property is enforced code
ownership and role authorization: implementation stays role-scoped while the
product description and cross-domain contracts are shared.

## Deploy

1. Create a Railway project from this repository. Railway will read the root
   `railway.toml` and build `deploy/railway/Dockerfile`.
2. Add a Railway volume mounted at `/data`. This persists Codex state, SILO's
   SQLite job ledger, worktrees, and the integration repository.
3. Set these Railway variables:
   - `OPENAI_API_KEY`: the API key used for model requests.
   - `SILO_CONFIG` (optional): defaults to `/data/silo/config.json`.
4. Copy `silo.example.json` to `/data/silo/config.json`, replace all token
   hashes, and create the configured project repository. Generate a SHA-256
   token hash inside the built container with
   `python3 -m silo.token`; SILO uses a salted scrypt hash and never stores the
   raw token.
5. Create the integration branch (by default `silo/integration`) and commit an
   architecture registry at `.silo/architecture.json`; use
   `architecture.example.json` as the starting shape.
6. Generate a Railway domain. The public health check is at `/healthz`, the
   SILO API is under `/api/v1`.

## SILO API

User endpoints accept `Authorization: Bearer USER_TOKEN`:

```text
GET  /api/v1/me
GET  /api/v1/architecture
POST /api/v1/jobs
GET  /api/v1/jobs/JOB_ID
```

Submit work using the member's assigned role:

```json
{
  "role": "database",
  "task": "Add the tenant membership migration and repository methods."
}
```

Requesting another role returns `ROLE_MISMATCH`. Each job starts from the
integration branch in a sparse worktree containing `.silo/` and the role's
owned roots. The agent output is checked against the ownership map before it
is staged or committed; a cross-domain diff is rejected with
`BOUNDARY_VIOLATION`.

Only the administrator bearer token may call
`POST /api/v1/jobs/JOB_ID/integrate`. Integration is refused if the
architecture digest changed after the job started or the cherry-pick
conflicts. SILO applies the job and runs all integration checks in a detached
candidate worktree; the live integration branch is fast-forwarded only after
every check passes. This deliberately keeps generation and integration as
separate trust decisions and avoids temporarily placing unvalidated code on the
integration branch.

### Architecture registry

The registry is created before coding and committed at
`.silo/architecture.json`. It must contain a version, whole-product summary,
contracts, and dependencies. Put API shapes, event schemas, shared types,
permissions, and domain dependencies in `contracts`. Specialists can read this
map but `.silo/` is not owned by any specialist, so their output cannot change
the approved architecture. Contract changes should be reviewed and committed
to the integration branch before dependent jobs begin. SILO rejects malformed
registries, duplicate contract IDs, missing contract ownership/definitions, and
non-semantic registry versions before a job can start.

### Ownership policy

`config.json` is the backend authority for users, roles, and writable roots.
Tokens are stored only as salted scrypt hashes. Use independently generated random
tokens of at least 32 bytes; protect the configuration with volume permissions
and Railway access controls. Paths are checked as normalized repository paths,
and parent traversal and absolute paths are rejected.

`integrationChecks` is a required list of commands expressed as argument
arrays, not shell strings. Configure the combined application's build,
contract-validation, and test commands here. SILO runs every check after the
candidate commit is applied; if a check fails, it discards the candidate and
leaves the live integration branch unchanged. Commands never pass through a
shell.

Optional `modelProvider` and `model` fields on each role select a Codex provider
configured in `CODEX_HOME/config.toml` and a model for that specialist. This
allows roles to use separate vendors or accounts; each provider's API-key
environment variable must also be present in the Railway deployment.
`maxConcurrentJobs` provides process-level backpressure; excess submissions
receive HTTP 429 instead of creating unbounded workers.

## Security and operational limits

- Use a private repository and never commit API keys, bearer tokens, or the
  populated SILO configuration.
- SILO supports multiple project members but one project and one integration
  repository per deployment. Run exactly one service replica and use separate
  deployments for unrelated tenants; SQLite and local Git locks are not a
  distributed coordination mechanism.
- Job worktrees isolate concurrent branches. Integration is serialized in the
  server, and the durable job ledger uses SQLite WAL mode.
- Job and integration decisions are written to the persistent audit
  ledger. Jobs interrupted by a container restart are marked failed with
  `PROCESS_RESTARTED` rather than remaining indefinitely in a running state;
  users can safely resubmit them.
- Role filtering is not a confidentiality boundary against a malicious user or
  adversarial agent: Codex executes commands in the container. Use separate
  containers or VMs per role if implementation secrecy between roles is a
  requirement.
- The gateway terminates public traffic, while SILO listens only on loopback
  and is exposed through nginx. There is intentionally no raw app-server
  endpoint that could bypass role authorization.
- Railway terminates TLS for the generated public domain.
- nginx applies per-IP request limits and security response headers in front of
  the loopback-only API.
- Container commands run as the unprivileged `www-data` user.
- `/data` is the only persistent location; installed operating-system packages
  disappear when Railway replaces the container.
- Back up `/data`, rotate bearer tokens, monitor job failures, and pin the image
  to a reviewed commit. The API intentionally does not return task text or raw
  provider output from its job-status endpoint.
