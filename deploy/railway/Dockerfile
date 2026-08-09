FROM rust:1.95-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libcap-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/codex-rs
COPY codex-rs/ ./
RUN cargo build --locked --release -p codex-cli --bin codex

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        nginx-light \
        procps \
        python3 \
        ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /src/codex-rs/target/release/codex /usr/local/bin/codex
COPY deploy/railway/nginx.conf.template /etc/nginx/nginx.conf.template
COPY deploy/railway/start.sh /usr/local/bin/start-codex-cloud
COPY deploy/railway/silo /opt/silo/silo

RUN chmod 0755 /usr/local/bin/start-codex-cloud \
    && mkdir -p /data/codex /data/silo /data/workspace \
    && chown -R www-data:www-data /data

ENV CODEX_HOME=/data/codex \
    CODEX_WORKSPACE=/data/workspace \
    PYTHONPATH=/opt/silo \
    PORT=8080 \
    RUST_LOG=info

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start-codex-cloud"]
