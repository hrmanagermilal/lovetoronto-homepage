#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
EMAIL="${SSL_EMAIL:-lovetoronto.office@gmail.com}"

docker compose up -d --wait proxy
docker compose run --rm --no-deps certbot certonly \
    --webroot --webroot-path /var/www/certbot \
    --cert-name www.lovetoronto.org \
    --domain www.lovetoronto.org \
    --domain lovetoronto.org \
    --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring --expand

docker compose exec -T proxy sh /etc/nginx/site/configure.sh
docker compose exec -T proxy nginx -t
docker compose exec -T proxy nginx -s reload

echo "Certificate installed. Verify https://www.lovetoronto.org/."
echo "Run sudo bash scripts/install-ssl-timer.sh to enable automatic renewal."
