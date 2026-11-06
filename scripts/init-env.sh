#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -e .env ]]; then
    echo ".env already exists; leaving it unchanged."
    exit 0
fi
command -v openssl >/dev/null
umask 077
PASSWORD="$(openssl rand -hex 32)"
set -o noclobber
sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$PASSWORD/" .env.example > .env
echo "Created .env with a random database password. Configure SMTP before enabling inquiry categories."
