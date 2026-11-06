"""Export the archived bilingual contact definitions without activating recipients."""
import json
from copy import deepcopy
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path


@dataclass
class Node:
    tag: str
    attrs: dict
    children: list = field(default_factory=list)
    parent: "Node | None" = None

    def all(self, tag):
        for child in self.children:
            if isinstance(child, Node):
                if child.tag == tag or (isinstance(tag, tuple) and child.tag in tag):
                    yield child
                yield from child.all(tag)

    def text(self):
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children)


class Parser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = Node("root", {})
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), parent=self.current)
        self.current.children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input",
                       "link", "meta", "param", "source", "track", "wbr"}:
            self.current = node

    def handle_endtag(self, tag):
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def export(frontend: Path):
    catalog = json.loads((frontend / "src/generated/catalog.json").read_text())
    configs = []
    overrides = json.loads((frontend / "src/contact-overrides.json").read_text())
    for language, page_id in (("ko", "contact.html"), ("en", "en/contact.html")):
        page = next(page for page in catalog["pages"] if page["id"] == page_id)
        parser = Parser()
        parser.feed(json.loads((frontend / "public/content" / page["contentFile"]).read_text())["html"])
        root = parser.root
        select = next(node for node in root.all("select") if node.attrs.get("id") == "menu-service")
        names = {node.attrs["value"]: node.text().strip()
                 for node in select.all("option") if node.attrs.get("value")}
        for form in root.all("form"):
            form_id = next((node.attrs.get("value") for node in form.all("input")
                            if node.attrs.get("name") == "_wpcf7"), None)
            if not form_id:
                continue
            wrapper = form.parent
            while wrapper and "grop-contact_form" not in wrapper.attrs.get("class", "").split():
                wrapper = wrapper.parent
            if not wrapper:
                raise ValueError(f"No contact wrapper for form {form_id}")
            category = next(name for name in wrapper.attrs["class"].split() if name in names)
            fields = []
            for node in form.all(("input", "textarea", "select")):
                tag = node.tag
                name = node.attrs.get("name", "")
                kind = node.attrs.get("type", "text") if tag == "input" else tag
                if not name or name.startswith("_") or kind in {"hidden", "submit", "button"}:
                    continue
                label = node.attrs.get("placeholder", "").strip() or name
                if kind == "checkbox":
                    label_node = node.parent
                    while label_node and label_node.tag != "label":
                        label_node = label_node.parent
                    if label_node:
                        label = label_node.text().strip()
                definition = {
                    "name": name, "label": label, "type": kind,
                    "required": node.attrs.get("aria-required") == "true" or kind == "checkbox",
                    "max_length": int(node.attrs.get("maxlength", "400")),
                    "options": [option.attrs.get("value", option.text()).strip()
                                for option in node.all("option")] if tag == "select" else [],
                }
                if kind == "checkbox":
                    waiver = next(form.all("button"), None)
                    ref = waiver.attrs.get("data-ref") if waiver else None
                    dialog = next((node for node in root.all("div")
                                   if node.attrs.get("id") == f"dialog-{ref}"), None)
                    definition["consent_text"] = dialog.text().strip() if dialog else label
                if name in {"text-dob", "text-date"}:
                    definition["format"] = "date"
                elif name == "text-yob":
                    definition["format"] = "year"
                if name == "menu-consent-other":
                    definition["label"] = ("대리 신청 권한 동의" if language == "ko"
                                           else "Authorization to apply on behalf of the client")
                elif name == "menu-home":
                    definition["label"] = "어르신의 거주 형태" if language == "ko" else "Client living arrangement"
                fields.append(definition)
            if form_id == overrides["form_id"]:
                for definition in fields:
                    if definition["name"] in overrides["labels"]:
                        definition["label"] = overrides["labels"][definition["name"]]
                insertion = next(index + 1 for index, definition in enumerate(fields)
                                 if definition["name"] == overrides["after"])
                fields[insertion:insertion] = overrides["fields"]
            rules = []
            if category == "contact-7":
                rules = [{
                    "type": "representative",
                    "trigger_fields": [
                        "text-name-other", "text-name-other-kor", "text-relationship-other",
                        "tel-phone-other", "email-address-other", "menu-consent-other",
                    ],
                    "name_fields": ["text-name-other", "text-name-other-kor"],
                    "required_fields": ["text-relationship-other", "tel-phone-other", "email-address-other"],
                    "consent_field": "menu-consent-other",
                    "consent_value": "예" if language == "ko" else "Yes",
                }]
            configs.append({
                "slug": f"{category}-{language}", "name": names[category],
                "language": language, "form_id": form_id, "active": False,
                "fields": fields, "rules": rules, "recipients": ["lovetoronto.office@gmail.com"],
                "subject_template": "[Love Toronto] ${category} - ${inquiry_id}",
                "body_template": "${category}\nReference: ${inquiry_id}\n\n${details}\n",
            })
    if len(configs) != 12:
        raise ValueError(f"Expected six bilingual categories; found {len(configs)}")
    for language in ("ko", "en"):
        event = next(config for config in configs if config["slug"] == f"contact-5-{language}")
        general = next(config for config in configs if config["slug"] == f"contact-6-{language}")
        general["fields"] = deepcopy(event["fields"])
        general["rules"] = deepcopy(event["rules"])
    return configs


if __name__ == "__main__":
    backend = Path(__file__).resolve().parents[1]
    target = backend / "config/contact-categories.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(export(backend.parent / "frontend"), ensure_ascii=False, indent=2) + "\n")
    print(f"Exported 12 inactive bilingual form configurations to {target}")
