from string import Template
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


class FormField(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-z][a-z0-9-]{0,79}$")
    label: str = Field(min_length=1, max_length=2000)
    type: Literal["text", "email", "tel", "textarea", "select", "checkbox", "date"]
    required: bool = False
    max_length: int = Field(default=400, ge=1, le=10000)
    options: list[str] = Field(default_factory=list, max_length=100)
    consent_text: str | None = Field(default=None, max_length=20000)
    format: Literal["date", "year"] | None = None


class RepresentativeRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["representative"] = "representative"
    trigger_fields: list[str] = Field(min_length=1, max_length=10)
    name_fields: list[str] = Field(min_length=1, max_length=2)
    required_fields: list[str] = Field(min_length=1, max_length=10)
    consent_field: str
    consent_value: str = Field(min_length=1, max_length=100)


class CategoryConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    name: str = Field(min_length=1, max_length=200)
    language: Literal["ko", "en"]
    form_id: str = Field(pattern=r"^[0-9]{1,20}$")
    active: bool = False
    fields: list[FormField] = Field(min_length=1, max_length=50)
    rules: list[RepresentativeRule] = Field(default_factory=list, max_length=5)
    recipients: list[EmailStr] = Field(default_factory=list, max_length=20)
    subject_template: str = Field(min_length=1, max_length=500)
    body_template: str = Field(min_length=1, max_length=20000)

    @model_validator(mode="after")
    def validate_config(self):
        names = [field.name for field in self.fields]
        if len(set(names)) != len(names):
            raise ValueError("Field names must be unique")
        if not any(field.name == "email-address" and field.type == "email" and field.required
                   for field in self.fields):
            raise ValueError("A required email-address email field is needed")
        if self.active and not self.recipients:
            raise ValueError("Active categories need at least one recipient")
        for field in self.fields:
            if field.type == "select" and not field.options:
                raise ValueError("Select fields need options")
        for rule in self.rules:
            referenced = [*rule.trigger_fields, *rule.name_fields, *rule.required_fields, rule.consent_field]
            if not set(referenced) <= set(names):
                raise ValueError("Conditional rule references unknown fields")
            consent = next(field for field in self.fields if field.name == rule.consent_field)
            if consent.type != "select" or rule.consent_value not in consent.options:
                raise ValueError("Conditional consent must refer to a valid select option")
        if "\n" in self.subject_template or "\r" in self.subject_template:
            raise ValueError("Subject cannot contain newlines")
        for value in (self.subject_template, self.body_template):
            template = Template(value)
            if not template.is_valid() or not set(template.get_identifiers()) <= {
                "category", "inquiry_id", "name", "email", "details",
            }:
                raise ValueError("Unknown template variable")
        return self


class InquiryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(pattern=r"^[a-z0-9-]{1,80}$")
    fields: dict[str, str | bool] = Field(max_length=50)


class PublicCategory(BaseModel):
    slug: str
    name: str
    language: Literal["ko", "en"]
    form_id: str
    fields: list[FormField]
    rules: list[RepresentativeRule]


class InquiryReceipt(BaseModel):
    id: str
    status: Literal["pending", "sent", "failed"]
