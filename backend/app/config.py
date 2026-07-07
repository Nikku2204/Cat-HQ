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

    # Govee smart plugs — mains power control (M5.5, docs/05)
    govee_api_key: str = ""
    # Explicit plug bindings: the EXACT deviceName from the Govee app.
    # Commands are refused for any plug not bound here (mains safety).
    govee_plug_litterrobot: str = ""
    govee_plug_feeder: str = ""
    power_cycle_delay_s: float = 8.0  # POWER_CYCLE_DELAY_S — off→on gap

    # Tapo camera — local Camera Account credentials (M6)
    tapo_cam_ip: str = ""
    tapo_cam_user: str = ""
    tapo_cam_pass: str = ""

    # WhatsApp alerts via CallMeBot (M8 pulled forward, 2026-07-06).
    # Free personal-use gateway: activate per callmebot.com, then set BOTH.
    # Notifications are disabled unless both are non-empty.
    callmebot_phone: str = ""      # CALLMEBOT_PHONE — incl. country code
    callmebot_api_key: str = ""    # CALLMEBOT_API_KEY

    @property
    def cats(self) -> list[str]:
        return [c.strip() for c in self.cat_names.split(",") if c.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
