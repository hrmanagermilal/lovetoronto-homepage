#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dry-run" ) ]]; then
    echo "Usage: $0 [--dry-run]" >&2
    exit 1
fi

docker compose run --rm --no-deps certbot renew \
    --cert-name www.lovetoronto.org --non-interactive "$@"

if [[ $# -eq 0 ]]; then
    docker compose exec -T proxy sh /etc/nginx/site/configure.sh
    docker compose exec -T proxy nginx -t
    docker compose exec -T proxy nginx -s reload
fi
