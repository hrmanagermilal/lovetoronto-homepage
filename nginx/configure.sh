#!/bin/sh
set -eu

printf '%s\n' 'limit_req_zone $binary_remote_addr zone=inquiries:10m rate=10r/m;' \
    > /etc/nginx/conf.d/00-rate-limit.conf

cert_dir=/etc/letsencrypt/live/www.lovetoronto.org
if [ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ]; then
    cp /etc/nginx/site/https.conf /etc/nginx/conf.d/default.conf
    cp /etc/nginx/site/senior-https.conf /etc/nginx/conf.d/senior.conf
    echo "HTTPS configuration enabled for www.lovetoronto.org (including senior ports 82/83)"
elif [ -d "$cert_dir" ]; then
    echo "ERROR: Incomplete certificate files in $cert_dir" >&2
    exit 1
else
    cp /etc/nginx/site/default.conf /etc/nginx/conf.d/default.conf
    cp /etc/nginx/site/senior.conf /etc/nginx/conf.d/senior.conf
    echo "No certificate yet; serving HTTP for ACME bootstrap."
fi
