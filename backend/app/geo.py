"""Admin access gate: only clients located near Toronto (or allow-listed) may reach the admin site.

The location comes from a local DB-IP City Lite database (CC BY 4.0, https://db-ip.com).
Anything that cannot be positively located inside the allowed radius is denied.
"""
import gzip
import logging
import math
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import date
from ipaddress import ip_address, ip_network
from pathlib import Path

import maxminddb

from .settings import Settings, settings

logger = logging.getLogger(__name__)
EARTH_RADIUS_KM = 6371.0088


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


class GeoGate:
    def __init__(self, config: Settings):
        self.config = config
        self.allowed = [ip_network(item.strip(), strict=False)
                        for item in config.admin_allowed_cidrs.split(",") if item.strip()]
        self._lock = threading.Lock()
        self._reader = None
        self._mtime = None
        self._checked = 0.0

    def _lookup(self, ip: str) -> dict | None:
        path = self.config.geoip_db
        with self._lock:
            now = time.monotonic()
            if self._reader is None or now - self._checked > 60:
                self._checked = now
                try:
                    mtime = os.stat(path).st_mtime
                except FileNotFoundError:
                    mtime = None
                if mtime != self._mtime:
                    old, self._reader, self._mtime = self._reader, None, mtime
                    if old:
                        old.close()
                    if mtime is not None:
                        self._reader = maxminddb.open_database(path)
            reader = self._reader
        if reader is None:
            logger.error("GeoIP database %s is missing; admin access denied", path)
            return None
        return reader.get(ip)

    def check(self, ip: str | None) -> tuple[bool, str]:
        if not ip:
            return False, "no client address"
        try:
            address = ip_address(ip)
        except ValueError:
            return False, "invalid client address"
        if any(address in network for network in self.allowed):
            return True, "allow-list"
        if not address.is_global:
            return False, "non-public address"
        record = self._lookup(str(address)) or {}
        country = (record.get("country") or {}).get("iso_code")
        location = record.get("location") or {}
        lat, lon = location.get("latitude"), location.get("longitude")
        if country != self.config.admin_geo_country or lat is None or lon is None:
            return False, f"outside area ({country or 'unknown'})"
        distance = distance_km(self.config.admin_geo_lat, self.config.admin_geo_lon, lat, lon)
        if distance > self.config.admin_geo_radius_km:
            return False, f"outside area ({distance:.0f} km)"
        return True, f"{distance:.0f} km from Toronto"


_gate: GeoGate | None = None


def gate() -> GeoGate:
    global _gate
    if _gate is None:
        _gate = GeoGate(settings())
    return _gate


def update(target: Path):
    """Download the current monthly DB-IP City Lite file, validate it and swap it in atomically."""
    today = date.today()
    months = [today.replace(day=1)]
    months.append(date(today.year - (today.month == 1), (today.month - 2) % 12 + 1, 1))
    target.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for month in months:
        url = f"https://download.db-ip.com/free/dbip-city-lite-{month:%Y-%m}.mmdb.gz"
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False, suffix=".tmp") as temp:
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "lovetoronto-geoip-update"})
                with urllib.request.urlopen(request, timeout=120) as response, gzip.GzipFile(fileobj=response) as data:
                    shutil.copyfileobj(data, temp)
                temp.close()
                reader = maxminddb.open_database(temp.name)
                toronto = reader.get("142.150.0.1") or {}
                reader.close()
                if "location" not in toronto:
                    raise ValueError("database has no location data")
                os.chmod(temp.name, 0o644)
                os.replace(temp.name, target)
                print(f"Installed {url} -> {target}")
                return
            except Exception as error:  # try the previous month before failing
                last_error = error
                print(f"Skipping {url}: {error}", file=sys.stderr)
                Path(temp.name).unlink(missing_ok=True)
    raise SystemExit(f"GeoIP update failed: {last_error}")


if __name__ == "__main__":
    if sys.argv[1:] == ["update"]:
        update(Path(settings().geoip_db))
    elif len(sys.argv) == 3 and sys.argv[1] == "check":
        print(gate().check(sys.argv[2]))
    else:
        raise SystemExit("Usage: python -m app.geo update | check IP")
