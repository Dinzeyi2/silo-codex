# Run Codex app-server on Railway

This deployment keeps the Codex source unchanged and packages the existing
`codex-app-server` behind an authenticated WebSocket gateway. It is intended
for a single trusted user. Do not expose it as a public multi-tenant service:
Codex can execute commands in the container workspace.

## Deploy

1. Create a Railway project from this repository. Railway will read the root
   `railway.toml` and build `deploy/railway/Dockerfile`.
2. Add a Railway volume mounted at `/data`. This persists Codex state and the
   working directory across deployments.
3. Set these Railway variables:
   - `CODEX_CLOUD_TOKEN`: a random URL-safe secret containing at least 32
     characters. Generate one with `openssl rand -hex 32`.
   - `OPENAI_API_KEY`: the API key used for model requests.
4. Generate a Railway domain. The public health check is at `/healthz`, and
   the authenticated WebSocket endpoint is `wss://YOUR_DOMAIN/ws`.

Clients must send this header during the WebSocket upgrade:

```text
Authorization: Bearer YOUR_CODEX_CLOUD_TOKEN
```

After connecting, speak the app-server JSON-RPC protocol: send `initialize`,
then `initialized`, before starting or resuming a thread. The WebSocket
transport is currently experimental, so pin deployments to a tested commit.

## Security and operational limits

- Use a private repository and never commit either secret.
- This is a single-container, single-tenant deployment. All connected clients
  reach the same app-server process and persistent workspace.
- The gateway terminates public traffic, while app-server listens only on the
  container loopback interface.
- Railway terminates TLS for the generated public domain.
- Container commands run as the unprivileged `www-data` user.
- `/data` is the only persistent location; installed operating-system packages
  disappear when Railway replaces the container.
