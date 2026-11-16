import argparse
import json
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import EmailStr, TypeAdapter
from sqlalchemy import select

from .db import SessionLocal
from .models import Category, Inquiry
from .schemas import CategoryConfig


def main():
    parser = argparse.ArgumentParser(description="Manage inquiry routing and admin accounts")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed")
    commands.add_parser("categories")
    recipients = commands.add_parser("set-all-recipients")
    recipients.add_argument("--recipient", action="append", required=True)
    category_recipients = commands.add_parser(
        "set-recipients", help="Update a category's recipients without changing activation or templates"
    )
    category_recipients.add_argument("slug")
    category_recipients.add_argument("--recipient", action="append", required=True)
    configure = commands.add_parser("configure")
    configure.add_argument("slug")
    configure.add_argument("--recipient", action="append", required=True)
    configure.add_argument("--subject")
    configure.add_argument("--body-file", type=Path)
    disable = commands.add_parser("disable")
    disable.add_argument("slug")
    sync = commands.add_parser("sync-form")
    sync.add_argument("slug")
    importing = commands.add_parser("import")
    importing.add_argument("file", type=Path)
    listing = commands.add_parser("inquiries")
    listing.add_argument("--limit", type=int, default=20, choices=range(1, 101))
    retry = commands.add_parser("retry")
    retry.add_argument("id", type=UUID)
    test_email = commands.add_parser("test-email")
    test_email.add_argument("--to", required=True)
    owner = commands.add_parser("create-owner", help="Create an owner admin and email the invitation link")
    owner.add_argument("--email", required=True)
    owner.add_argument("--name", default="")
    owner.add_argument("--print-link", action="store_true",
                       help="Print the one-time link instead of emailing it (when SMTP is unavailable)")
    commands.add_parser("admins")
    archive = commands.add_parser("import-archive-newsletters",
                                  help="Copy the archived site's newsletters into the media volume and database")
    archive.add_argument("--archive", type=Path, default=Path("/archive"))
    commands.add_parser("media-gc", help="Delete uploaded files that nothing references (older than one day)")
    args = parser.parse_args()
    with SessionLocal.begin() as db:
        if args.command in {"seed", "import"}:
            file = Path("config/contact-categories.json") if args.command == "seed" else args.file
            configs = TypeAdapter(list[CategoryConfig]).validate_json(file.read_text())
            for config in configs:
                existing = db.get(Category, config.slug)
                if args.command == "seed" and existing:
                    continue
                if existing:
                    for key, value in config.model_dump(mode="json").items():
                        setattr(existing, key, value)
                else:
                    db.add(Category(**config.model_dump(mode="json")))
            print(f"Validated {len(configs)} categories ({args.command})")
        elif args.command == "categories":
            for category in db.scalars(select(Category).order_by(Category.slug)):
                print(category.slug, "active" if category.active else "disabled", category.recipients)
        elif args.command == "set-all-recipients":
            recipients = TypeAdapter(list[EmailStr]).validate_python(args.recipient)
            categories = db.scalars(select(Category).with_for_update()).all()
            if not categories:
                parser.error("No categories found; run seed first")
            for category in categories:
                values = {key: getattr(category, key) for key in CategoryConfig.model_fields}
                config = CategoryConfig.model_validate({**values, "recipients": recipients})
                category.recipients = list(config.recipients)
            print(f"Updated recipients for {len(categories)} categories; activation and templates unchanged")
        elif args.command == "set-recipients":
            category = db.get(Category, args.slug)
            if not category:
                parser.error("Unknown category")
            values = {key: getattr(category, key) for key in CategoryConfig.model_fields}
            config = CategoryConfig.model_validate({**values, "recipients": args.recipient})
            category.recipients = list(config.recipients)
            print(f"Updated recipients for {category.slug}; activation and templates unchanged")
        elif args.command == "sync-form":
            configs = TypeAdapter(list[CategoryConfig]).validate_json(
                Path("config/contact-categories.json").read_text()
            )
            config = next((config for config in configs if config.slug == args.slug), None)
            category = db.get(Category, args.slug)
            if not config or not category:
                parser.error("Unknown category")
            category.fields = [field.model_dump(mode="json") for field in config.fields]
            category.rules = [rule.model_dump(mode="json") for rule in config.rules]
            print(f"Updated {category.slug} field definitions; recipients, activation and templates unchanged")
        elif args.command in {"configure", "disable"}:
            category = db.get(Category, args.slug)
            if not category:
                parser.error("Unknown category")
            values = {key: getattr(category, key) for key in CategoryConfig.model_fields}
            if args.command == "disable":
                values["active"] = False
            else:
                values.update(active=True, recipients=args.recipient)
                if args.subject is not None:
                    values["subject_template"] = args.subject
                if args.body_file:
                    values["body_template"] = args.body_file.read_text()
            config = CategoryConfig.model_validate(values)
            for key, value in config.model_dump(mode="json").items():
                setattr(category, key, value)
            print(f"Updated {category.slug}")
        elif args.command == "inquiries":
            for inquiry in db.scalars(select(Inquiry).order_by(Inquiry.created_at.desc()).limit(args.limit)):
                print(inquiry.id, inquiry.category_slug, inquiry.status, inquiry.attempts, inquiry.last_error)
        elif args.command == "retry":
            inquiry = db.get(Inquiry, args.id)
            if not inquiry or inquiry.status != "failed":
                parser.error("Only failed inquiries can be retried")
            from datetime import datetime, timezone
            inquiry.status = "pending"
            inquiry.attempts = 0
            inquiry.next_attempt_at = datetime.now(timezone.utc)
            inquiry.last_error = None
            print(f"Queued {inquiry.id}; manual retry may duplicate a previously accepted SMTP delivery.")
        elif args.command == "test-email":
            from .settings import settings
            from .worker import send_mail
            config = settings()
            if not config.smtp_host:
                parser.error("SMTP_HOST is not configured. Update .env and recreate backend/mail-worker.")
            recipient = str(TypeAdapter(EmailStr).validate_python(args.to))
            message_id = uuid4()
            message = Inquiry(
                id=message_id, recipients=[recipient], reply_to=str(config.smtp_from),
                subject="[Love Toronto] SMTP delivery test",
                body=f"This is a test email from Love Toronto.\nReference: {message_id}\n"
                     "No real inquiry or personal information is included.\n",
            )
            send_mail(message, config)
            print(f"SMTP server accepted test message {message_id}. Check the recipient inbox/spam folder.")
        elif args.command == "create-owner":
            from fastapi import HTTPException

            from .admin import issue_link, send_link
            from .models import AdminUser
            email = str(TypeAdapter(EmailStr).validate_python(args.email)).lower()
            if db.scalar(select(AdminUser).where(AdminUser.email == email)):
                parser.error("An admin with this email already exists; use the admin site to resend its link")
            user = AdminUser(email=email, name=args.name, role="owner", active=True, failed_logins=0)
            db.add(user)
            db.flush()
            if args.print_link:
                print(f"Owner {email} created. One-time password setup link (72h):\n{issue_link(db, user, 'invite')}")
            else:
                try:
                    send_link(db, user, "invite")
                except HTTPException as error:
                    parser.error(str(error.detail))
                print(f"Owner {email} created; invitation emailed.")
        elif args.command == "import-archive-newsletters":
            from .archive_import import import_archive_newsletters
            imported, skipped = import_archive_newsletters(db, args.archive)
            print(f"Imported {imported} archived newsletters; {skipped} already present")
        elif args.command == "admins":
            from .models import AdminUser
            for user in db.scalars(select(AdminUser).order_by(AdminUser.created_at)):
                state = "active" if user.active else "disabled"
                print(user.email, user.role, state, "password-set" if user.password_hash else "invited",
                      user.last_login_at or "-")
        elif args.command == "media-gc":
            import time

            from .media import media_path
            from .models import HeroSlide, Newsletter
            from .settings import settings
            used = set(db.scalars(select(HeroSlide.image_url)))
            used |= set(db.scalars(select(Newsletter.file_url))) | set(db.scalars(select(Newsletter.thumbnail_url)))
            removed = 0
            for path in Path(settings().media_dir).glob("*/*"):
                url = f"/media/{path.parent.name}/{path.name}"
                if media_path(url) and url not in used and time.time() - path.stat().st_mtime > 86400:
                    path.unlink()
                    removed += 1
            print(f"Removed {removed} unreferenced uploads")


if __name__ == "__main__":
    main()
