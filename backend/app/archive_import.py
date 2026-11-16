"""One-off import of the newsletters listed on the archived WordPress site.

Files are copied out of the archive (frontend/public/archive) into the media
volume through the same validation as admin uploads. Already imported titles
are skipped, so the import can be re-run safely.
"""
import json
from datetime import date
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .media import media_path, save_file
from .models import Newsletter

MANIFEST = Path("config/archive-newsletters.json")


def import_archive_newsletters(db: Session, archive: Path, manifest: Path = MANIFEST) -> tuple[int, int]:
    entries = json.loads(manifest.read_text())
    existing = set(db.scalars(select(Newsletter.title)))
    root = archive.resolve()

    def archived(relative: str) -> Path:
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise FileNotFoundError(f"Archive file not found: {relative}")
        return path

    imported, stored = 0, []
    try:
        for entry in entries:
            if entry["title"] in existing:
                continue
            if bool(entry.get("file")) == bool(entry.get("link")):
                raise ValueError(f"{entry['title']}: exactly one of file/link is required")
            if entry.get("file"):
                with archived(entry["file"]).open("rb") as source:
                    file_url = save_file("newsletter", source)
                stored.append(file_url)
            else:
                if not entry["link"].startswith("https://"):
                    raise ValueError(f"{entry['title']}: links must use https")
                file_url = entry["link"]
            thumbnail = ""
            if entry.get("thumbnail"):
                with archived(entry["thumbnail"]).open("rb") as source:
                    thumbnail = save_file("thumbnail", source)
                stored.append(thumbnail)
            db.add(Newsletter(title=entry["title"], file_url=file_url, thumbnail_url=thumbnail,
                              published_on=date.fromisoformat(entry["published_on"]), active=True))
            existing.add(entry["title"])
            imported += 1
        db.flush()
    except BaseException:
        # Leave no orphaned copies when the transaction is rolled back.
        for url in stored:
            if path := media_path(url):
                path.unlink(missing_ok=True)
        raise
    return imported, len(entries) - imported
