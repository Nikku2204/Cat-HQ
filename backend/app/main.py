"""Cat HQ backend — M3: adapters + SQLite event recorder.

The lifespan handler owns adapter and recorder lifecycles. M4 adds the
WebSocket broadcaster here.
"""
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request

from .adapters.base import DeviceAdapter
from .adapters.litterrobot import LitterRobotAdapter
from .adapters.petlibro import PetlibroAdapter
from .api import devices, events
from .config import get_settings
from .db import SessionLocal, dispose_db, init_db
from .pollers import Recorder

logger = logging.getLogger(__name__)
settings = get_settings()
STARTED_AT = datetime.now(timezone.utc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    adapters: dict[str, DeviceAdapter] = {}
    if settings.whisker_email and settings.whisker_password:
        litterrobot = LitterRobotAdapter(
            email=settings.whisker_email, password=settings.whisker_password
        )
        adapters["litterrobot"] = litterrobot
        # start() never raises — connect failures land in the health badge.
        await litterrobot.start()
    else:
        logger.info("litterrobot adapter not configured (no WHISKER_* in .env)")
    if settings.petlibro_email and settings.petlibro_password:
        # NB: Petlibro allows ONE session per account — this login kicks any
        # phone app logged into the same account. Use the dedicated account.
        feeder = PetlibroAdapter(
            email=settings.petlibro_email,
            password=settings.petlibro_password,
            tz=settings.tz,
        )
        adapters["feeder"] = feeder
        await feeder.start()
    else:
        logger.info("feeder adapter not configured (no PETLIBRO_* in .env)")
    app.state.adapters = adapters
    recorder = Recorder(adapters, SessionLocal)
    await recorder.start()
    yield
    await recorder.stop()
    for adapter in adapters.values():
        await adapter.stop()
    await dispose_db()


app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)
app.include_router(devices.router)
app.include_router(events.router)


@app.get("/")
def root():
    return {"app": settings.app_name, "hint": "see /health"}


@app.get("/health")
async def health(request: Request):
    """M0 acceptance endpoint: build info + which integrations are configured
    + per-adapter health badges.

    Deliberately unauthenticated — it exposes no secrets and is useful for
    uptime checks (and the docker-compose healthcheck).
    """
    now = datetime.now(timezone.utc)
    adapters = getattr(request.app.state, "adapters", {})
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
        "adapters": {
            name: (await adapter.health()).model_dump(mode="json")
            for name, adapter in adapters.items()
        },
    }
