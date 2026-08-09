# Build context MUST be the repository root (not silo/), e.g.:
#   docker build -f silo/deploy/Dockerfile .
# On Railway: set this service's "Dockerfile Path" to silo/deploy/Dockerfile and leave its
# "Root Directory" empty/default, so the build context stays the whole repo — the codex binary
# stage needs codex-rs/, and the Node stage needs sdk/typescript/ as a workspace dependency.

# ---- Stage 1: build the `codex` CLI binary from source -------------------------------------
# Mirrors deploy/railway/Dockerfile's proven pattern for codex-app-server, just a different bin
# from the same `codex-cli` crate. Building from this repo's own codex-rs (rather than pulling
# a published @openai/codex npm package) keeps the binary in lockstep with whatever's checked
# out, and avoids the Codex TS SDK's npm platform-package resolution entirely (see
# codexRunner.ts's use of SILO_CODEX_BINARY_PATH / codexPathOverride).
FROM rust:1.95-bookworm AS codex-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libcap-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/codex-rs
COPY codex-rs/ ./
RUN cargo build --locked --release -p codex-cli --bin codex

# ---- Stage 2: build the SILO Node/TypeScript app ------------------------------------------
FROM node:22-bookworm-slim AS silo-builder

# git is required here, not just in the runtime stage: sdk/typescript's devDependencies include
# a `github:...` package, which pnpm fetches via a git subprocess during install. Missing this
# fails with "pnpm: not found: git" — easy to miss testing locally where git is already on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /build

# Minimal footprint for pnpm to resolve the workspace graph: every package.json listed in
# pnpm-workspace.yaml must be present, but we only need full source for the two packages SILO
# actually depends on (sdk/typescript, silo itself) — not codex-cli's own build output.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY codex-cli/package.json ./codex-cli/package.json
COPY codex-rs/responses-api-proxy/npm/package.json ./codex-rs/responses-api-proxy/npm/package.json
COPY sdk/typescript/ ./sdk/typescript/
COPY silo/ ./silo/

RUN pnpm install --filter @openai/silo... --frozen-lockfile
RUN pnpm --filter @openai/silo run build

# ---- Stage 3: runtime -----------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=codex-builder /src/codex-rs/target/release/codex /usr/local/bin/codex
COPY --from=silo-builder /build /app

WORKDIR /app/silo
RUN mkdir -p /data

ENV SILO_DATA_DIR=/data \
    SILO_CODEX_BINARY_PATH=/usr/local/bin/codex \
    PORT=8080 \
    NODE_ENV=production

# Runs as root: this container's only job is to run SILO in an isolated environment, and a
# Railway-attached volume at /data is simplest to get working reliably as root on first setup.
# Dropping to a non-root user is a reasonable hardening follow-up once the volume/permissions
# are confirmed working end to end (watch for ownership mismatches on first volume mount).
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js", "cloud"]
