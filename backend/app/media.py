import os
import re
import tempfile
import warnings
from pathlib import Path
from typing import BinaryIO
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps

from .settings import settings

Image.MAX_IMAGE_PIXELS = 50_000_000
MB = 1024 * 1024
# kind -> (directory, max upload bytes, max output edge in px; None = PDF)
KINDS = {"hero": ("hero", 20 * MB, 2560), "thumbnail": ("thumbs", 10 * MB, 600), "newsletter": ("newsletters", 50 * MB, None)}
MEDIA_URL = re.compile(r"^/media/(hero|thumbs|newsletters)/[0-9a-f]{32}\.(jpg|png|pdf)$")


def media_path(url: str) -> Path | None:
    if not MEDIA_URL.fullmatch(url):
        return None
    return Path(settings().media_dir) / url.removeprefix("/media/")


def _store(directory: str, extension: str, write) -> str:
    target_dir = Path(settings().media_dir) / directory
    target_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}.{extension}"
    with tempfile.NamedTemporaryFile(dir=target_dir, delete=False, suffix=".part") as temp:
        try:
            write(temp)
            temp.flush()
            os.fchmod(temp.fileno(), 0o644)
            temp.close()
            os.replace(temp.name, target_dir / name)
        except BaseException:
            Path(temp.name).unlink(missing_ok=True)
            raise
    return f"/media/{directory}/{name}"


def save_upload(kind: str, upload: UploadFile) -> str:
    return save_file(kind, upload.file)


def save_file(kind: str, source: BinaryIO) -> str:
    """Validate, normalise and store a seekable file; returns its /media/ URL."""
    if kind not in KINDS:
        raise HTTPException(404, "Unknown upload type")
    directory, limit, edge = KINDS[kind]
    source.seek(0, os.SEEK_END)
    size = source.tell()
    source.seek(0)
    if size == 0:
        raise HTTPException(422, "빈 파일입니다.")
    if size > limit:
        raise HTTPException(413, f"파일이 너무 큽니다 (최대 {limit // MB}MB).")
    if edge is None:
        head = source.read(1024)
        source.seek(max(0, size - 2048))
        tail = source.read()
        if not head.startswith(b"%PDF-") or b"%%EOF" not in tail:
            raise HTTPException(422, "PDF 파일만 올릴 수 있습니다.")
        source.seek(0)

        def copy(target):
            while chunk := source.read(MB):
                target.write(chunk)
        return _store(directory, "pdf", copy)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    raise HTTPException(422, "JPG, PNG, WebP 이미지만 올릴 수 있습니다.")
                image = ImageOps.exif_transpose(image)
                image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                alpha = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
                image = image.convert("RGBA" if alpha else "RGB")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "이미지 파일을 읽을 수 없습니다.") from None
    # Re-encoding drops metadata (EXIF/GPS) and anything that is not pixel data.
    if alpha:
        return _store(directory, "png", lambda target: image.save(target, "PNG", optimize=True))
    return _store(directory, "jpg", lambda target: image.save(target, "JPEG", quality=86, optimize=True, progressive=True))
