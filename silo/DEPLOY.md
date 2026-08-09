# Deploying SILO's cloud API to Railway

This deploys `silo cloud` — the multi-project, hosted mode meant to be called from your own
backend. It is a **separate Railway service** from the existing `codex-app-server` deployment in
`deploy/railway/` — both can live in the same Railway project if you like, they don't share state.

## 1. Create the service

In the Railway dashboard: **New Service → Deploy from GitHub repo** → pick this repo.

**Critical step, easy to miss:** this repo already has a `railway.toml` at its root (for the
unrelated `codex-app-server` service in `deploy/railway/`). Railway's "config-as-code" makes that
root file **override anything you type in the dashboard's Build settings**, for *every* service
in the repo, unless a service is explicitly pointed at a different config file. Skipping this
step is why the build silently keeps using `deploy/railway/Dockerfile` no matter what you set
Dockerfile Path to in the UI.

On the `@openai/silo` service, go to **Settings → Config-as-code** and set:

- **Config File Path** → `silo/railway.toml`

That file (checked into this repo) sets Builder=Dockerfile and Dockerfile Path correctly for
SILO specifically. Do this *before* checking the Build section below — otherwise the Build
section's fields are cosmetic and get overridden anyway.

Then in that service's **Settings → Build** (should now match `silo/railway.toml`, but confirm):

- **Builder**: Dockerfile
- **Dockerfile Path**: `silo/deploy/Dockerfile`
- **Root Directory**: leave empty/default (the repo root) — the Dockerfile needs `codex-rs/`
  (to build the `codex` binary) and `sdk/typescript/` (a workspace dependency of `silo/`), both
  of which live outside `silo/`. If Root Directory is set to `silo/`, the Docker build context
  won't include them and the build will fail.

## 2. Attach a volume

SILO needs persistent storage for the project registry and every project's cloned repo. Without
one, both are wiped on every redeploy/restart.

**Settings → Volumes → New Volume**, mount path: `/data` (matches `ENV SILO_DATA_DIR=/data` set
in the Dockerfile).

## 3. Set environment variables

| Variable             | Required | Notes                                                                                                                                                                                                                                            |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SILO_SERVICE_TOKEN` | yes      | ≥32 URL-safe characters. Every request except `/healthz` must send `Authorization: Bearer <this>`. Generate one with `openssl rand -hex 32`. Treat it like a database credential — only your backend should hold it, never ship it to a browser. |
| `PORT`               | no       | Railway sets this automatically; the Dockerfile defaults to 8080.                                                                                                                                                                                |

Per-role AI provider variables are **not** set here — they're read from each project's own
`silo/config/providers.yaml` (inside that project's repo) at task time, resolved via
`${ENV_VAR}` placeholders against _this service's_ environment. So if a project's
`providers.yaml` references `${AUTH_PROVIDER_API_KEY}`, you set `AUTH_PROVIDER_API_KEY` on this
Railway service too. Every project sharing this deployment shares that environment — if
different projects truly need different provider credentials, give them different `${VAR}` names
in their own `providers.yaml` (e.g. `${ACME_AUTH_PROVIDER_API_KEY}`) rather than colliding on the
same name.

## 4. Deploy

Push/merge to trigger a build. First deploy compiles `codex` from `codex-rs/` via Rust release
build (same pattern as `deploy/railway/Dockerfile`'s `codex-app-server`) — expect this to take
a while the first time; Railway caches Docker layers on subsequent builds if `codex-rs/` hasn't
changed.

Confirm it's up: `curl https://<your-service>.up.railway.app/healthz` → `{"status":"ok"}`.

## 5. Register a project

Each project is a target repo SILO orchestrates. Register one per product/customer:

```bash
curl -X POST https://<your-service>.up.railway.app/v1/projects \
  -H "Authorization: Bearer $SILO_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "id": "acme",
    "name": "Acme Subscriptions",
    "repoUrl": "https://github.com/acme/product.git",
    "githubToken": "ghp_xxx",
    "baseBranch": "integration"
  }'
```

`githubToken` needs read + write access to that repo (a fine-grained PAT scoped to just that
repo is the least-privilege option; a GitHub App installation token works too). It's stored in
`SILO_DATA_DIR/projects.json` on the attached volume — not in git, not in an env var, not
returned by any API response. The target repo itself needs `architecture/` and
`silo/config/{ownership,members,providers}.yaml` at its root — see
`silo/examples/sample-project/` for what that looks like, or copy `silo/config/*.yaml` as a
starting point and customize the owned paths for that project's actual layout.

## 6. Your backend calls it

```bash
curl -X POST https://<your-service>.up.railway.app/v1/projects/acme/tasks \
  -H "Authorization: Bearer $SILO_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"memberId": "alice", "role": "database", "prompt": "Add a users table."}'
```

Your backend is responsible for mapping your own authenticated end user to a `memberId` — SILO
trusts whatever `memberId` your backend sends and checks it against that project's
`silo/config/members.yaml`. Never expose `SILO_SERVICE_TOKEN` to the browser; only your backend
should hold it, exactly as you would a database credential.

A `200` with `"merged": true, "pushed": true` means the change is live on `origin/<baseBranch>`
on GitHub. A `409` means the task ran but was rejected by ownership boundary validation — see
`violations` in the response body. See `silo/README.md` for the full response shape and status
codes.

## What this does _not_ handle yet

- **No per-project provider credential isolation** — see the table above; all projects on one
  SILO deployment share the same environment for `${VAR}` resolution in `providers.yaml`.
- **No horizontal scaling** — `asyncLock.ts` only serializes within one process. Running more
  than one `silo cloud` replica against the same volume needs an external lock (e.g. a
  Postgres/Redis advisory lock) added around the merge/push path first.
- **Runs as root in the container** — see the note in `silo/deploy/Dockerfile`. Fine for a
  single isolated service; harden later if your threat model needs it.
- **No project-deletion cleanup** — `DELETE`-ing a project's registration doesn't remove its
  cloned repo from `/data/repos/`; do that manually if you need the disk back.
