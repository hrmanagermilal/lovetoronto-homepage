# lovetoronto-homepage

## Docker deployment

Install Docker Engine and Docker Compose v2, then run from this directory:

```sh
sudo bash scripts/init-env.sh
# Edit .env to configure SMTP before enabling inquiry categories.
sudo docker compose up --build -d
sudo docker compose ps
```

Open `http://localhost/` (or your server's public IP). The `proxy` service runs
an Nginx reverse proxy on host ports **80/443**, forwarding requests to
`homepage-web:8080` over the Compose network. The existing direct web endpoint on port
**85** remains available for compatibility.

Allow inbound TCP ports **80 and 443** in the host firewall and, on Azure, the VM's
network security group. Without a certificate the proxy serves HTTP only.

### Senior community service (HTTPS ports 82/83)

The same proxy exposes the sibling `senior_community_services_core` application:

| Endpoint | Destination |
|---|---|
| `https://www.lovetoronto.org:82` | Public, volunteer and client screens |
| `https://www.lovetoronto.org:83` | Admin screens (`/` redirects to `/admin`) |

Requests to `/admin` or `/admin/*` on port 82 redirect to port 83, preserving
the path and query string. Once the `www.lovetoronto.org` certificate exists,
`configure.sh` installs `nginx/senior-https.conf`: both ports use TLS with the
homepage certificate (`nginx/senior-tls.conf`), and plain `http://` requests on
the same port are redirected to `https://`. Before issuance, `nginx/senior.conf`
serves both ports over HTTP. Both route through `nginx/senior-proxy.conf` and
Docker DNS to `senior-web:8080`; the Rails container and database publish no
host ports.
Distinct `homepage-web` and `senior-web` DNS aliases prevent the two Compose
services named `web` from being confused on the proxy's attached networks.

Start this Compose stack first to create `lovetoronto-senior-proxy`, then start
the senior stack:

```sh
sudo docker compose up -d proxy
cd ../senior_community_services_core
# Set APP_HOST=www.lovetoronto.org (a certified hostname, no scheme or port).
sudo docker compose --env-file docker/production.env up -d --build --remove-orphans
```

`--remove-orphans` removes the previous senior Caddy container, if present,
without deleting its certificate volumes. Allow inbound TCP **82/83** in the
host firewall and Azure network security group. Do not remove the homepage
network while the senior stack is attached.

The senior Compose stack no longer sets `ALLOW_HTTP`, so Rails uses its HTTPS
production defaults (Secure cookies, HSTS) and builds mail/SMS links as
`https://<APP_HOST>:82`. Access by IP address shows a certificate warning and
is rejected by the Rails host check. Do not treat the admin port as an
authorization boundary.

### Homepage admin site (HTTPS 81) and managed front page (HTTPS 84)

| Endpoint | Purpose |
|---|---|
| `https://www.lovetoronto.org:81` | Admin site: admin accounts, hero slides, newsletters. **Toronto area only.** |
| `https://www.lovetoronto.org:84` | New front page: the same site as 443 plus the hero slides and newsletters published from the admin site |

Port 443 is unchanged: it keeps showing the archived hero and newsletter list.
Both ports use the `www.lovetoronto.org` certificate and are only enabled when
it exists (`configure.sh` installs `nginx/admin-https.conf` and
`nginx/front-https.conf`). Allow inbound TCP **81/84** in the host firewall
and the Azure network security group.

**Toronto-only access.** Every request on port 81 (pages, assets and API) goes
through an nginx `auth_request` to the backend geo gate (`backend/app/geo.py`).
The client IP is located with the free [DB-IP](https://db-ip.com) City Lite
database (CC BY 4.0) and allowed only when it is in Canada and within
`ADMIN_GEO_RADIUS_KM` (default **50 km**, i.e. the GTA) of Toronto City Hall.
Private, unknown and unlocatable addresses are denied, and so is everything
while the database is missing (fail-closed). The admin API also re-checks the
gate itself, and `/api/admin/` returns 404 on ports 80/443/84/85. IP
geolocation is approximate: some Toronto connections (mobile networks, VPNs)
may be located elsewhere. For such cases add an emergency allow-list in `.env`
and recreate the backend:

```dotenv
ADMIN_ALLOWED_CIDRS=203.0.113.10/32,198.51.100.0/24
```

Never allow-list Docker gateway addresses (`172.x.x.1`): connections relayed
by Docker's userland proxy (e.g. IPv6 or localhost) appear with that address.
Denials are logged by the backend with the reason
(`sudo docker compose logs backend | grep denied`); check a specific address with
`sudo docker compose exec backend python -m app.geo check 203.0.113.10`.

Download the database before first use and install the monthly update timer:

```sh
sudo docker compose run --rm geoip-update
sudo bash scripts/install-geoip-timer.sh
```

The backend reloads the file automatically within a minute of an update.

**Accounts and email 2FA.** The email address is the account ID. An owner
invites an address; the invitee sets a password through a one-time link
(72 hours). Each sign-in needs the password **and** a six-digit code emailed to
that address (10 minutes, five attempts). Five wrong passwords lock the account
for 15 minutes; login endpoints are also rate-limited per IP. Sessions use an
`HttpOnly`, `Secure`, `SameSite=Strict` cookie and end after 2 hours idle or 12
hours. Passwords are stored as scrypt hashes; links, codes and sessions only as
SHA-256 digests. Roles:

| Role | Can |
|---|---|
| Owner | Everything, including inviting, editing, disabling accounts and sending reset links |
| Editor | Hero slides, newsletters and their own name/password |

At least one active owner must remain; owners cannot disable or demote
themselves. To change an address, invite the new one and disable the old one.
Admin email (invites, codes, resets) is sent directly through the SMTP settings
in `.env`; if SMTP rejects it, the action fails and nothing is created.
Create the first owner from the server:

```sh
sudo docker compose exec backend python -m app.cli create-owner --email owner@example.org
# Without working SMTP, print the one-time link instead of emailing it:
sudo docker compose exec backend python -m app.cli create-owner --email owner@example.org --print-link
sudo docker compose exec backend python -m app.cli admins
```

**Hero slides.** The archived Korean and English home slides were copied into
the database by migration `0003`, so admins can edit, hide, reorder or replace
them per language. Uploaded images (JPG/PNG/WebP, max 20 MB) are re-encoded
(metadata such as GPS is removed) and scaled to at most 2560 px. Links must be
`https://`/`http://` or internal `#/page?file=...` addresses. If a language
has no visible slides, port 84 falls back to the archived slides.

**Newsletters.** The database is the source of truth for the newsletter pages
on port 84 (`소식지` / `News`, including the old `news/page/2|3` addresses):
the list is loaded from `GET /api/v1/site/content`, newest publication date
first, nine per page with generated pagination (`&p=2`, …). The English News
page shows the same list. Each item has a title, publication date, an uploaded
PDF (max 50 MB) **or** an external `https://` link (e.g. YouTube), and an
optional cover image. Port 443 still shows the archived list.

All 27 newsletters of the archived site (25 PDFs, 2 YouTube links, 11 covers)
were imported with their files copied into the `media` volume. The list and
dates are in `backend/config/archive-newsletters.json`; dates were derived from
the titles (month or quarter, otherwise January). The import skips titles that
already exist, so it can be re-run safely, e.g. after restoring an empty
database:

```sh
sudo docker compose run --rm --no-deps \
  -v "$PWD/frontend/public/archive:/archive:ro" \
  backend python -m app.cli import-archive-newsletters
```

Uploads are stored in the `media` volume and served by the proxy under
`/media/` on ports 81 and 84. Files are removed when their slide/newsletter is
deleted or replaced; uploads that were never saved can be removed with
`sudo docker compose exec backend python -m app.cli media-gc`. Back up the
`media` volume together with the database.

The admin UI lives in `admin/` (React + Vite, served by the `admin-web`
container); the public API for port 84 is `GET /api/v1/site/content`.

Run isolated nginx routing regression checks (no production containers changed):

```sh
sudo bash scripts/test-senior-proxy.sh
```

```sh
sudo docker compose logs -f proxy web
sudo docker compose down
```

The proxy, web, API and mail worker use read-only filesystems and temporary `/tmp` storage. The proxy
starts after the web service is healthy and resolves the web container through
Docker DNS so backend container replacement does not require restarting it.
The proxy uses the standard Nginx image with a root master to read Certbot's
restricted private key; workers remain unprivileged. Its runtime directories
are temporary, and certificates are mounted read-only.

## HTTPS and automatic renewal

This follows the `sample` project's Certbot webroot approach, adding an explicit
renewal timer and Nginx reload. One certificate (named `www.lovetoronto.org`)
covers both **www.lovetoronto.org** and **lovetoronto.org**; HTTPS requests to
the apex domain redirect to `https://www.lovetoronto.org`.

1. Point `www.lovetoronto.org` and `lovetoronto.org` DNS to **20.106.233.21** (remove or update any
   conflicting CNAME/AAAA records). At initial setup it resolved to
   `160.153.0.97`, so issuance must wait for the DNS change.
2. Keep public port **80** accessible for Let's Encrypt HTTP-01 challenges,
   including after HTTPS is enabled. Open **443** for HTTPS traffic.
3. Obtain the certificate and enable HTTPS:

   ```sh
   sudo bash scripts/init-ssl.sh
   ```

   The registration email defaults to `lovetoronto.office@gmail.com`.
   Override it with `sudo SSL_EMAIL=you@example.org bash scripts/init-ssl.sh`.
   Running the script accepts the Let's Encrypt subscriber agreement.
   Issuance failure exits with an error and does not replace working HTTP with
   a temporary self-signed certificate. The script can be rerun safely.

4. On this Ubuntu/systemd host, install the persistent twice-daily renewal timer:

   ```sh
   sudo bash scripts/install-ssl-timer.sh
   sudo bash scripts/renew-ssl.sh --dry-run
   systemctl list-timers lovetoronto-ssl-renew.timer
   ```

   Certbot renews only when needed. After a successful production check, the
   script validates and reloads Nginx so renewed certificates are served without
   rebuilding images. A failed renewal or reload fails the systemd service;
   inspect it with:

   ```sh
   sudo journalctl -u lovetoronto-ssl-renew.service
   sudo systemctl start lovetoronto-ssl-renew.service
   curl -I https://www.lovetoronto.org/
   ```

After issuance, HTTP redirects to `https://www.lovetoronto.org`, except ACME
challenges and `/healthz`. The health endpoint checks the backend without a TLS
redirect. The direct port **85** remains HTTP for compatibility; restrict it in
the Azure firewall if external bypass access is unwanted.

Certificates and ACME account keys persist in the Compose `certificates` volume;
challenges use `acme-webroot`. Back up certificate storage securely. Do not run
`docker compose down -v`, which deletes these volumes. If moving the repository,
rerun the timer installer to update its working path. To disable renewal:

```sh
sudo systemctl disable --now lovetoronto-ssl-renew.timer
```

## Inquiry backend (FastAPI + PostgreSQL)

The Compose stack includes PostgreSQL 17 (`db`), a one-shot Alembic migration
service (`migrate`), FastAPI (`backend`), and a durable mail worker (`mail-worker`).
Neither PostgreSQL nor FastAPI publishes a host port. Nginx routes `/api/` to
FastAPI on the internal network; port 85 also supports this route for local
diagnostics. Use **HTTPS** for real submissions: legal and counselling inquiries
contain sensitive personal data. Restrict diagnostic port 85 in the firewall.

The six existing dropdown categories retain their distinct Korean/English forms:

| Category | Configuration slugs |
|---|---|
| Legal Counsel Referral / 법률상담 | `contact-1-ko`, `contact-1-en` |
| Psychotherapeutic Counseling / 정신건강상담 | `contact-3-ko`, `contact-3-en` |
| Adult Day Program | `contact-4-ko`, `contact-4-en` |
| Senior Community Services / 시니어 복지 | `contact-7-ko`, `contact-7-en` |
| Event / 행사 | `contact-5-ko`, `contact-5-en` |
| General Inquiry / 기타 | `contact-6-ko`, `contact-6-en` |

Language variants have separate DB configurations so recipients and email
wording can vary by language as well as service. Existing legal/psychotherapy
waivers are displayed before the required consent checkbox can be submitted.
Event and General Inquiry share the same seven-field form in each language:
English name, Korean name, phone, address, email, message and required personal
data collection consent. The exporter reuses the Event field definitions for
General Inquiry to keep their initial schemas identical. They remain separate
categories with independent recipients and mail templates. Browser tests check
matching controls/layout and consent-gated submission for both categories.
The English mental-health form includes the same report/reason/format/schedule/
expectation questions as Korean. Intentional English additions are defined in
`frontend/src/contact-overrides.json`, used by the UI and schema exporter, without
rewriting archived source content.
The API also checks required fields, email addresses, select options, length
limits and consent; clients cannot choose recipients or email templates.
Senior-service applications include client identity/date of birth, address,
contact details, representative details, reason/expectations, optional diagnosis
date, living arrangement, contact time, notes and collection consent.
Representative fields are optional for self-applications. If any representative
field is provided, an English **or** Korean representative name, relationship,
phone, email and affirmative authorization are required in both the UI and API.
Birth/diagnosis dates must use valid `yyyy-mm-dd` dates; birth years use four
digits.

### Environment and mail account

`scripts/init-env.sh` creates a git-ignored, mode-600 `.env` from `.env.example`
with a random PostgreSQL password, without overwriting an existing file.
Real database and SMTP passwords belong only in the local `.env`, never the
tracked `.env.example`. The database password can be chosen before first
startup; for an initialized database, change the PostgreSQL role password as
well as `.env`, then recreate the API and worker containers.
Configure these values in `.env`, not in source code or the category database:

```dotenv
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=lovetoronto.office@gmail.com
SMTP_PASSWORD=your-provider-app-password
SMTP_FROM=lovetoronto.office@gmail.com
```

The example assumes Gmail; use the actual provider's settings and an app
password/SMTP credential (not a normal login password where app passwords are
required). `SMTP_SECURITY=tls` supports implicit TLS, usually on port 465.
`plain` is only for a trusted unauthenticated internal relay/test SMTP server;
authentication over plaintext is rejected. `SMTP_USER` follows `sample/app`;
STARTTLS, SMTP login, a 30-second timeout, five-second polling, and three
delivery attempts also follow that implementation.

After editing `.env`, recreate services to load new environment variables:

```sh
sudo docker compose up -d backend mail-worker
```

If `SMTP_HOST` is empty, the worker logs an explicit warning and leaves queued
inquiries pending without consuming retries. No real email is sent in this state.
The user-facing receipt says **saved / queued**, not "email sent".

After configuring SMTP, send an explicit synthetic connectivity test without
activating categories, changing production recipients or saving a fake inquiry:

```sh
sudo docker compose exec backend python -m app.cli test-email --to RECIPIENT_EMAIL
```

This uses the same SMTP delivery function as the worker and fails explicitly if
SMTP is unconfigured or rejects delivery. SMTP acceptance does not guarantee
inbox placement; check the recipient's inbox/spam folder.

### Register category recipients and templates

On startup, migrations create `inquiry_categories` and `inquiries`; seeding adds
the 12 archived form definitions with all categories active. They route to
`lovetoronto.office@gmail.com`; Korean and English senior community services
also route to `lovetoronto.senior@gmail.com`. Existing DB settings are never
overwritten by the seed step. Configure SMTP and HTTPS before production use.

Existing databases keep their saved settings after seeding. Apply the bundled
routing and activate all 12 inquiry forms without changing their field schemas
or mail templates:

```sh
sudo docker compose exec backend python -m app.cli import config/contact-categories.json
```

This affects future submissions only; previously accepted inquiries retain
their saved recipient snapshots. Other database settings such as admin accounts
and saved inquiries are unaffected. For just the senior categories:

```sh
sudo docker compose exec backend python -m app.cli configure contact-7-ko \
  --recipient lovetoronto.office@gmail.com \
  --recipient lovetoronto.senior@gmail.com
sudo docker compose exec backend python -m app.cli configure contact-7-en \
  --recipient lovetoronto.office@gmail.com \
  --recipient lovetoronto.senior@gmail.com
```

`configure` activates the category after validation. `set-all-recipients` changes
recipients without changing activation, forms or mail templates.

```sh
sudo docker compose exec backend python -m app.cli categories

# Example: replace this address with the approved recipient for each category.
sudo docker compose exec backend python -m app.cli configure contact-1-ko \
  --recipient legal-team@example.org \
  --subject '[Love Toronto 법률상담] ${name} / ${inquiry_id}'
```

Repeat `--recipient` for multiple recipients; repeat the command per category and
language. No arbitrary production routing is inferred from sample code.
`configure` activates the category after validation. Disable with:

```sh
sudo docker compose exec backend python -m app.cli disable contact-1-ko
```

Templates are **plain UTF-8 text**, using Python `string.Template` placeholders:
`${category}`, `${inquiry_id}`, `${name}`, `${email}`, `${details}`. `${details}`
contains that category's field labels and submitted values. Arbitrary code or
template expressions are not evaluated. For a full custom body:

```sh
sudo docker compose run --rm --no-deps \
  -v /absolute/path/to/legal-body.txt:/config/legal-body.txt:ro \
  backend python -m app.cli configure contact-1-ko \
  --recipient legal-team@example.org --body-file /config/legal-body.txt
```

`backend/config/contact-categories.json` contains the initial schemas and
templates. For bulk updates, copy and edit this file and explicitly import it:

```sh
sudo docker compose run --rm --no-deps \
  -v /absolute/path/to/categories.json:/config/categories.json:ro \
  backend python -m app.cli import /config/categories.json
```

Import updates matching slugs, validates recipient/template settings and rejects
unknown template variables. Keep schema field names compatible with the
archived form controls; new UI fields require a corresponding frontend change.
To regenerate the initial definitions after intentionally changing archived forms:
`python3 backend/scripts/export_archive_forms.py`. This does not update live DB
settings automatically.
When deploying an intentional field-definition update to an already seeded DB,
apply it explicitly without changing routing or activation:

```sh
sudo docker compose exec backend python -m app.cli sync-form contact-3-en
sudo docker compose exec backend python -m app.cli sync-form contact-7-ko
sudo docker compose exec backend python -m app.cli sync-form contact-7-en
```

This replaces that category's field definitions with the bundled version;
review any locally customized definitions first. Previously saved inquiry
snapshots remain unchanged.

### Storage, delivery, and API

- `GET /api/v1/inquiry-categories`: active categories and field definitions only;
  recipients and email templates are not exposed.
- `POST /api/v1/inquiries`: requires a UUID `Idempotency-Key` header and a JSON
  body of `{ "category": "contact-1-ko", "fields": { ... } }`.
- HTTP **202** means the inquiry and formatted email were committed together.
  The response is `{ "id": "<uuid>", "status": "pending" }` (or the current
  `sent`/`failed` status on an idempotent retry).
- The same key and payload return the original inquiry. Reusing the key for a
  different payload returns **409**. Invalid fields/consent return **422**;
  unknown or inactive categories return **404**. Requests are limited to 64 KiB.
- Both Nginx entry points limit `/api/` to 10 requests/minute/IP, burst 5
  (excess returns **429**). This is a basic limit, not a complete anti-spam or
  bot protection system.
- Stored inquiries include the submitted fields, category/consent definition
  snapshot, frozen recipients, rendered subject/body, timestamps, delivery state,
  attempts and sanitized error type. Later category changes do not reroute
  already accepted inquiries.
- Workers lock queue rows with `FOR UPDATE SKIP LOCKED`; SMTP failure retries
  after 60 and 120 seconds, then marks `failed` on attempt 3. Successful delivery
  sets `sent_at`. Inquiry data remains saved even if email fails.
- Delivery is **at least once**, not exactly once: SMTP may accept a message
  before a connection/DB failure. A stable Message-ID helps downstream
  deduplication but does not guarantee it; partial recipient acceptance can also
  duplicate mail for already-accepted recipients on retry.

No public inquiry-list or configuration endpoint is provided. Inspect delivery
metadata or retry a terminal failure using the server-only CLI:

```sh
sudo docker compose exec backend python -m app.cli inquiries --limit 20
sudo docker compose exec backend python -m app.cli retry INQUIRY_UUID
sudo docker compose logs -f backend mail-worker
```

There is no inquiry administration UI (the port-81 admin site manages hero
slides, newsletters and admin accounts only). Manage DB access, data retention,
encrypted backups and mailbox access according to the organization's privacy
policy. PostgreSQL data persists in `postgres-data`; **do not run
`docker compose down -v`**, which deletes the database and certificate volumes.
Changing `POSTGRES_PASSWORD` in `.env` does not change an existing database
role's password; rotate it in PostgreSQL as well.

### Verification

Backend tests use a separate ephemeral PostgreSQL database and a local test SMTP
server, never the production DB or a real recipient:

```sh
sudo docker compose -p lovetoronto-backend-test -f compose.test.yaml up \
  --build --abort-on-container-exit --exit-code-from backend-test
sudo docker compose -p lovetoronto-backend-test -f compose.test.yaml down
```

The tests cover all 12 localized form schemas, routing, consent validation,
idempotency/concurrency, migrations, actual local SMTP delivery, row locking and
retry exhaustion, plus the admin geo gate, CSRF checks, invite/password/email-code
login, lockout, roles, uploads and the published hero/newsletter content. In `frontend`, `npm run build` runs content tests and type
checks; `npm run test:contact` uses Playwright Chromium against a running site
(`TEST_URL` overrides the default Vite URL), with API responses mocked so no real
inquiry or email is created. For Vite development, `/api` proxies to
`127.0.0.1:8000`; run a backend there or temporarily publish its port on localhost.

See [frontend/README.md](frontend/README.md) for application and test details.
