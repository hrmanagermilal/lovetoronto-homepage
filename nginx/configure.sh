#!/bin/sh
set -eu

printf '%s\n' \
    'limit_req_zone $binary_remote_addr zone=inquiries:10m rate=10r/m;' \
    'limit_req_zone $binary_remote_addr zone=admin_auth:10m rate=20r/m;' \
    'limit_req_zone $binary_remote_addr zone=site:10m rate=120r/m;' \
    > /etc/nginx/conf.d/00-rate-limit.conf

cert_dir=/etc/letsencrypt/live/www.lovetoronto.org
if [ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ]; then
    cp /etc/nginx/site/https.conf /etc/nginx/conf.d/default.conf
    cp /etc/nginx/site/senior-https.conf /etc/nginx/conf.d/senior.conf
    cp /etc/nginx/site/admin-https.conf /etc/nginx/conf.d/admin.conf
    cp /etc/nginx/site/front-https.conf /etc/nginx/conf.d/front.conf
    echo "HTTPS configuration enabled for www.lovetoronto.org (senior 82/83, admin 81, front page 84)"
elif [ -d "$cert_dir" ]; then
    echo "ERROR: Incomplete certificate files in $cert_dir" >&2
    exit 1
else
    cp /etc/nginx/site/default.conf /etc/nginx/conf.d/default.conf
    cp /etc/nginx/site/senior.conf /etc/nginx/conf.d/senior.conf
    rm -f /etc/nginx/conf.d/admin.conf /etc/nginx/conf.d/front.conf
    echo "No certificate yet; serving HTTP for ACME bootstrap. Admin (81) and front page (84) need HTTPS and stay closed."
fi
