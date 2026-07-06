"""Env-driven settings. Every variable is documented in .env.example."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # core
    app_name: str = "Cat HQ"
    version: str = "0.1.0"
    build_sha: str = "dev"            # BUILD_SHA
    tz: str = "UTC"                   # TZ — owner's IANA timezone
    cat_names: str = ""               # CAT_NAMES — comma-separated, cosmetic
    cathq_auth_token: str = ""    # CATHQ_AUTH_TOKEN — REQUIRED from M5;
                                  # startup refuses ""/"change-me"
    database_path: str = "/data/cathq.db"
    enable_docs: bool = False     # ENABLE_DOCS — expose /docs+/openapi.json
                                  # (dev only; the schema maps the control
                                  # surface, so keep it off in production)

    # Whisker / Litter-Robot 4 (M1)
    whisker_email: str = ""
    whisker_password: str = ""

    # Petlibro — the DEDICATED second account, see 02-INTEGRATIONS.md (M2)
    petlibro_email: str = ""
    petlibro_password: str = ""

    # Tapo camera — local Camera Account credentials (M6)
    tapo_cam_ip: str = ""
    tapo_cam_user: str = ""
    tapo_cam_pass: str = ""

    @property
    def cats(self) -> list[str]:
        return [c.strip() for c in self.cat_names.split(",") if c.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
