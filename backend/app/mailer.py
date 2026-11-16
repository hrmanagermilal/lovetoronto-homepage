import smtplib
import ssl
from email.message import EmailMessage

from .settings import Settings


def smtp_send(message: EmailMessage, config: Settings):
    if not config.smtp_host:
        raise RuntimeError("SMTP_HOST is not configured")
    context = ssl.create_default_context()
    if config.smtp_security == "tls":
        client = smtplib.SMTP_SSL(config.smtp_host, config.smtp_port, timeout=30, context=context)
    else:
        client = smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=30)
    with client:
        client.ehlo()
        if config.smtp_security == "starttls":
            client.starttls(context=context)
            client.ehlo()
        if config.smtp_user:
            client.login(config.smtp_user, config.smtp_password.get_secret_value())
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


def send_text(to: str, subject: str, body: str, config: Settings):
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = str(config.smtp_from)
    message["To"] = to
    message.set_content(body)
    smtp_send(message, config)
