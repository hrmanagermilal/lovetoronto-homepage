#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="senior-proxy-test-$$"
network="$name-network"
upstream="$name-upstream"
homepage="$name-homepage"
proxy="$name-proxy"

cleanup() {
    docker rm -f "$proxy" "$upstream" "$homepage" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run -d --name "$upstream" --hostname senior-fixture \
    --network "$network" --network-alias senior-web --network-alias web \
    -v "$ROOT_DIR/scripts/fixtures/senior-upstream.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:stable-alpine >/dev/null
docker run -d --name "$homepage" --hostname homepage-fixture \
    --network "$network" --network-alias homepage-web --network-alias web \
    -v "$ROOT_DIR/scripts/fixtures/senior-upstream.conf:/etc/nginx/conf.d/default.conf:ro" \
    nginx:stable-alpine >/dev/null
docker run -d --name "$proxy" --network "$network" \
    -p 127.0.0.1::8080 -p 127.0.0.1::8082 -p 127.0.0.1::8083 \
    -v "$ROOT_DIR/nginx:/etc/nginx/site:ro" --tmpfs /etc/nginx/conf.d \
    nginx:stable-alpine sh -c 'sh /etc/nginx/site/configure.sh && exec nginx -g "daemon off;"' >/dev/null

public_port="$(docker port "$proxy" 8082/tcp | cut -d: -f2)"
admin_port="$(docker port "$proxy" 8083/tcp | cut -d: -f2)"
homepage_port="$(docker port "$proxy" 8080/tcp | cut -d: -f2)"
for attempt in {1..30}; do
    if curl --silent --fail "http://127.0.0.1:$public_port/up" >/dev/null; then
        break
    fi
    sleep 1
done

assert_response() {
    local port="$1" host_port="$2" path="$3" expected="$4"
    local response
    response="$(curl --silent --show-error --dump-header - --output /dev/null \
        -H "Host: senior.example.org:$host_port" "http://127.0.0.1:$port$path")"
    if [[ "$response" != *"$expected"* ]]; then
        printf 'FAIL %s: expected %s, got %s\n' "$path" "$expected" "$response" >&2
        exit 1
    fi
}

assert_response "$public_port" 82 '/admin?tab=users' 'Location: http://senior.example.org:83/admin?tab=users'
assert_response "$public_port" 82 '/admin/users?page=2' 'Location: http://senior.example.org:83/admin/users?page=2'
assert_response "$admin_port" 83 '/?locale=ko' 'Location: http://senior.example.org:83/admin?locale=ko'
assert_response "$homepage_port" 80 '/' 'X-Test-Upstream: homepage-fixture'
assert_response "$homepage_port" 80 '/healthz' 'X-Test-Upstream: homepage-fixture'

for host_port in 82 83; do
    port="$public_port"
    [[ "$host_port" == 83 ]] && port="$admin_port"
    response="$(curl --silent --show-error --fail \
        -H "Host: senior.example.org:$host_port" \
        -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Port: 443' \
        -H 'X-Forwarded-For: 203.0.113.99' \
        "http://127.0.0.1:$port/sign_in?locale=ko")"
    [[ "$response" == "senior.example.org:$host_port|http|$host_port|"*'|/sign_in?locale=ko' ]]
    [[ "$response" != *'203.0.113.99'* ]]
    assert_response "$port" "$host_port" '/sign_in' 'X-Test-Upstream: senior-fixture'
done

docker exec "$proxy" nginx -t
printf '%s\n' 'PASS: homepage isolation, public/admin routing, redirects and forwarded headers'
