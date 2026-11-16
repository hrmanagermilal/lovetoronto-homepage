#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $EUID -ne 0 ]]; then
    echo "Run this script as root (sudo bash scripts/install-geoip-timer.sh)." >&2
    exit 1
fi
if [[ ! "$ROOT_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    echo "Unsupported project path for systemd: $ROOT_DIR" >&2
    exit 1
fi
command -v docker >/dev/null
command -v systemctl >/dev/null

install -m 644 "$ROOT_DIR/systemd/lovetoronto-geoip-update.service" \
    /etc/systemd/system/lovetoronto-geoip-update.service
sed -i "s|@PROJECT_DIR@|$ROOT_DIR|g" /etc/systemd/system/lovetoronto-geoip-update.service
install -m 644 "$ROOT_DIR/systemd/lovetoronto-geoip-update.timer" \
    /etc/systemd/system/lovetoronto-geoip-update.timer
systemctl daemon-reload
systemctl enable --now lovetoronto-geoip-update.timer
systemctl list-timers lovetoronto-geoip-update.timer
