#!/bin/sh
set -eu

case "${CODEX_CLOUD_TOKEN:-}" in
    ''|*[!A-Za-z0-9._~-]*)
        echo "CODEX_CLOUD_TOKEN must contain at least 32 URL-safe characters." >&2
        exit 1
        ;;
esac

if [ "${#CODEX_CLOUD_TOKEN}" -lt 32 ]; then
    echo "CODEX_CLOUD_TOKEN must contain at least 32 URL-safe characters." >&2
    exit 1
fi

case "${PORT:-}" in
    ''|*[!0-9]*)
        echo "PORT must be a number." >&2
        exit 1
        ;;
esac

mkdir -p "$CODEX_HOME" "$CODEX_WORKSPACE"
chown -R www-data:www-data "$CODEX_HOME" "$CODEX_WORKSPACE"

sed \
    -e "s/__PORT__/$PORT/g" \
    -e "s/__CLOUD_TOKEN__/$CODEX_CLOUD_TOKEN/g" \
    /etc/nginx/nginx.conf.template >/tmp/nginx.conf

cd "$CODEX_WORKSPACE"
runuser -u www-data -- codex-app-server --listen ws://127.0.0.1:4500 &
app_server_pid=$!

shutdown() {
    kill -TERM "$app_server_pid" 2>/dev/null || true
    nginx -s quit -c /tmp/nginx.conf -p /tmp 2>/dev/null || true
}
trap shutdown INT TERM EXIT

nginx -c /tmp/nginx.conf -p /tmp -g 'daemon off;' &
nginx_pid=$!

while kill -0 "$app_server_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
    sleep 1
done

if ! kill -0 "$app_server_pid" 2>/dev/null; then
    wait "$app_server_pid"
else
    wait "$nginx_pid"
fi
