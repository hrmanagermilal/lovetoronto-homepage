from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, EmailStr, Field, SecretStr, model_validator
from pydantic_settings import BaseSettings
from sqlalchemy import URL


class Settings(BaseSettings):
    postgres_host: str = "db"
    postgres_db: str = "lovetoronto"
    postgres_user: str = "lovetoronto"
    postgres_password: SecretStr
    smtp_host: str = ""
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_security: Literal["starttls", "tls", "plain"] = "starttls"
    smtp_user: str = Field(default="", validation_alias=AliasChoices("SMTP_USER", "SMTP_USERNAME", "smtp_user"))
    smtp_password: SecretStr = SecretStr("")
    smtp_from: EmailStr = "lovetoronto.office@gmail.com"

    @model_validator(mode="after")
    def secure_smtp(self):
        if self.smtp_security == "plain" and self.smtp_user:
            raise ValueError("SMTP authentication requires TLS")
        if bool(self.smtp_user) != bool(self.smtp_password.get_secret_value()):
            raise ValueError("SMTP_USER and SMTP_PASSWORD must be configured together")
        return self

    @property
    def database_url(self) -> URL:
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.postgres_host,
            database=self.postgres_db,
        )


@lru_cache
def settings() -> Settings:
    return Settings()
