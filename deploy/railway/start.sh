#!/bin/sh
set -eu

case "${PORT:-}" in
    ''|*[!0-9]*)
        echo "PORT must be a number." >&2
        exit 1
        ;;
esac

mkdir -p "$CODEX_HOME" "$CODEX_WORKSPACE" /data/silo
chown -R www-data:www-data "$CODEX_HOME" "$CODEX_WORKSPACE" /data/silo

if [ ! -r "${SILO_CONFIG:-/data/silo/config.json}" ]; then
    echo "SILO configuration is missing; see deploy/railway/README.md." >&2
    exit 1
fi

sed \
    -e "s/__PORT__/$PORT/g" \
    /etc/nginx/nginx.conf.template >/tmp/nginx.conf

runuser -u www-data -- python3 -m silo.server &
silo_pid=$!

shutdown() {
    kill -TERM "$silo_pid" 2>/dev/null || true
    nginx -s quit -c /tmp/nginx.conf -p /tmp 2>/dev/null || true
}
trap shutdown INT TERM EXIT

nginx -c /tmp/nginx.conf -p /tmp -g 'daemon off;' &
nginx_pid=$!

while kill -0 "$silo_pid" 2>/dev/null \
    && kill -0 "$nginx_pid" 2>/dev/null; do
    sleep 1
done

if ! kill -0 "$silo_pid" 2>/dev/null; then
    wait "$silo_pid"
else
    wait "$nginx_pid"
fi
