"""Admin accounts with email 2FA, hero slides and newsletters.

Hero slides are seeded from the archived home pages so administrators start
from what the site currently shows.
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"

UPLOADS = "/archive/wp-content/uploads"
HERO_SEED = [
    ("ko", f"{UPLOADS}/2020/04/main_banner_4.jpg", "한인 동포 사회를 섬기는\n러브 토론토", "", "", False),
    ("ko", f"{UPLOADS}/2026/07/%EB%AC%BC%EB%8C%84%EB%8F%99%EC%82%B0-%ED%9B%84%EC%9B%90%ED%9A%8C-3.png",
     "물 댄 동산\n후원회", "", "", False),
    ("ko", f"{UPLOADS}/2020/03/main_banner_2.jpg", "캐나다법률정보 책자\n한글 번역본",
     "법률 책자 보러 가기", "#/page?file=lawbook.html", False),
    ("en", f"{UPLOADS}/2020/04/main_banner_4.jpg", "We support Korean Community\nLove Toronto", "", "", False),
    ("en", f"{UPLOADS}/2020/03/main_banner_2.jpg", "Korean-translated Canadian Legal Information Booklets",
     "See Detail", "#/page?file=index__p%3D3298.html", False),
    ("en", f"{UPLOADS}/2020/03/KBS_banner.png", "Interview with KBS Korean Network", "See Detail",
     "http://world.kbs.co.kr/service/contents_view.htm?lang=k&menu_cate=people&id=&board_seq=379863", True),
    ("en", f"{UPLOADS}/2021/04/89242-scaled.jpg",
     "2021 Job opening for Summer Job Student\nRegistration Ends May 31, 2021", "See Detail",
     "#/page?file=en%2Fevent-item%2Fsummer-job-student-%EB%AA%A8%EC%A7%91-%EA%B3%B5%EA%B3%A0-2%2Findex.html", False),
]


def timestamps():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def upgrade():
    op.create_table(
        "admin_users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("role", sa.String(10), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("password_hash", sa.String(300)),
        sa.Column("failed_logins", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True)),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        *timestamps(),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("role IN ('owner', 'editor')", name="ck_admin_users_role"),
    )
    op.create_table(
        "admin_tokens",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(10), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        *timestamps(),
    )
    op.create_index("ix_admin_tokens_user_id", "admin_tokens", ["user_id"])
    op.create_table(
        "admin_challenges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        *timestamps(),
    )
    op.create_index("ix_admin_challenges_user_id", "admin_challenges", ["user_id"])
    op.create_table(
        "admin_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False),
        *timestamps(),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip", sa.String(45), nullable=False),
    )
    op.create_index("ix_admin_sessions_user_id", "admin_sessions", ["user_id"])
    hero = op.create_table(
        "hero_slides",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("image_url", sa.String(500), nullable=False),
        sa.Column("alt", sa.String(200), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("button_label", sa.String(100), nullable=False),
        sa.Column("button_url", sa.String(500), nullable=False),
        sa.Column("new_tab", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("language IN ('ko', 'en')", name="ck_hero_slides_language"),
    )
    op.create_table(
        "newsletters",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("file_url", sa.String(500), nullable=False),
        sa.Column("thumbnail_url", sa.String(500), nullable=False),
        sa.Column("published_on", sa.Date(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        *timestamps(),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    positions = {}
    rows = []
    for language, image, title, label, url, new_tab in HERO_SEED:
        positions[language] = positions.get(language, 0) + 1
        rows.append({
            "language": language, "position": positions[language], "image_url": image, "alt": "",
            "title": title, "button_label": label, "button_url": url, "new_tab": new_tab, "active": True,
        })
    op.bulk_insert(hero, rows)


def downgrade():
    for table in ["newsletters", "hero_slides", "admin_sessions", "admin_challenges", "admin_tokens", "admin_users"]:
        op.drop_table(table)
