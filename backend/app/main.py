"""Cat HQ backend — M0: app skeleton + /health.

Later milestones hang off this file: a lifespan() handler will start the
device pollers (M3) and the WebSocket broadcaster (M4).
"""
from datetime import datetime, timezone

from fastapi import FastAPI

from .config import get_settings

settings = get_settings()
STARTED_AT = datetime.now(timezone.utc)

app = FastAPI(title=settings.app_name, version=settings.version)


@app.get("/")
def root():
    return {"app": settings.app_name, "hint": "see /health"}


@app.get("/health")
def health():
    """M0 acceptance endpoint: build info + which integrations are configured.

    Deliberately unauthenticated — it exposes no secrets and is useful for
    uptime checks (and the docker-compose healthcheck).
    """
    now = datetime.now(timezone.utc)
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "build": settings.build_sha,
        "started_at_utc": STARTED_AT.isoformat(),
        "uptime_seconds": int((now - STARTED_AT).total_seconds()),
        "server_time_utc": now.isoformat(),
        "timezone": settings.tz,
        "cats": settings.cats,
        "configured": {
            "whisker": bool(settings.whisker_email),
            "petlibro": bool(settings.petlibro_email),
            "tapo": bool(settings.tapo_cam_ip),
        },
    }
