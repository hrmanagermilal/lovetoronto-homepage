import logging
import signal
import smtplib
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from sqlalchemy import select

from .db import SessionLocal
from .mailer import smtp_send
from .models import Inquiry
from .settings import Settings, settings

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 3
POLL_INTERVAL_SECONDS = 5


def send_mail(inquiry: Inquiry, config: Settings):
    message = EmailMessage()
    message["Subject"] = inquiry.subject
    message["From"] = str(config.smtp_from)
    message["To"] = ", ".join(inquiry.recipients)
    message["Reply-To"] = inquiry.reply_to
    message["Message-ID"] = f"<inquiry-{inquiry.id}@www.lovetoronto.org>"
    message.set_content(inquiry.body)
    smtp_send(message, config)


def deliver_one(config: Settings) -> bool:
    if not config.smtp_host:
        raise RuntimeError("SMTP_HOST is not configured")
    with SessionLocal.begin() as db:
        inquiry = db.scalar(
            select(Inquiry)
            .where(Inquiry.status == "pending", Inquiry.next_attempt_at <= datetime.now(timezone.utc))
            .order_by(Inquiry.created_at)
            .with_for_update(skip_locked=True).limit(1)
        )
        if not inquiry:
            return False
        inquiry.attempts += 1
        try:
            send_mail(inquiry, config)
        except (smtplib.SMTPException, OSError) as error:
            inquiry.last_error = type(error).__name__
            inquiry.next_attempt_at = datetime.now(timezone.utc) + timedelta(
                seconds=60 * 2 ** (inquiry.attempts - 1)
            )
            if inquiry.attempts >= MAX_ATTEMPTS:
                inquiry.status = "failed"
            logger.error("Inquiry %s delivery %s (attempt %s): %s",
                         inquiry.id, inquiry.status, inquiry.attempts, inquiry.last_error)
        else:
            inquiry.status = "sent"
            inquiry.sent_at = datetime.now(timezone.utc)
            inquiry.last_error = None
            logger.info("Inquiry %s sent", inquiry.id)
    return True


def main():
    logging.basicConfig(level=logging.INFO)
    config = settings()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if not config.smtp_host:
        logger.warning("SMTP_HOST is empty: inquiries remain pending until SMTP is configured.")
    while not stopping:
        if not config.smtp_host or not deliver_one(config):
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
