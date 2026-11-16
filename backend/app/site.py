from fastapi import APIRouter
from sqlalchemy import select

from .db import SessionLocal
from .models import HeroSlide, Newsletter

router = APIRouter(prefix="/api/v1/site")


@router.get("/content")
def content():
    """Published hero slides and newsletters for the managed front page (port 84)."""
    with SessionLocal() as db:
        slides = db.scalars(select(HeroSlide).where(HeroSlide.active.is_(True))
                            .order_by(HeroSlide.language, HeroSlide.position, HeroSlide.id)).all()
        newsletters = db.scalars(select(Newsletter).where(Newsletter.active.is_(True))
                                 .order_by(Newsletter.published_on.desc(), Newsletter.id.desc())).all()
    hero = {"ko": [], "en": []}
    for slide in slides:
        hero[slide.language].append({
            "image": slide.image_url, "alt": slide.alt, "title": slide.title,
            "buttonLabel": slide.button_label, "buttonUrl": slide.button_url, "newTab": slide.new_tab,
        })
    return {
        "hero": hero,
        "newsletters": [{"title": item.title, "file": item.file_url, "thumbnail": item.thumbnail_url,
                         "kind": "link" if item.file_url.startswith("https://") else "pdf",
                         "date": item.published_on.isoformat()} for item in newsletters],
    }
