"""Cat HQ backend — M5: adapters + recorder + WebSocket hub + auth + PWA.

The lifespan handler owns adapter, recorder, and hub lifecycles. When a
frontend build exists (app/static, copied in by the Docker build), the
backend also serves the PWA — one origin for REST, WS, and UI.
"""
import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

from .adapters.base import DeviceAdapter
from .adapters.govee import GoveePlugAdapter
from .adapters.litterrobot import LitterRobotAdapter
from .adapters.petlibro import PetlibroAdapter
from .api import devices, events, ws
from .auth import require_auth
from .broadcast import Hub
from .config import get_settings
from .db import SessionLocal, dispose_db, init_db
from .models import Event, iso_utc_now
from .pollers import Recorder

logger = logging.getLogger(__name__)
settings = get_settings()
STARTED_AT = datetime.now(timezone.utc)


def _hub_notifier(device_id: str, adapter: DeviceAdapter, hub: Hub):
    """Adapter on_refresh hook: snapshot state+health, publish to the hub.
    Sync + fire-and-forget so adapter bookkeeping never blocks on clients."""

    async def _send() -> None:
        health = await adapter.health()
        state = None
        if adapter.connected:
            state = (await adapter.get_state()).model_dump(mode="json")
        hub.publish({
            "kind": "state",
            "device_id": device_id,
            "health": health.model_dump(mode="json"),
            "state": state,
        })

    def notify() -> None:
        asyncio.get_running_loop().create_task(_send())

    return notify


def _power_event_writer(device_id: str):
    """on_event hook for plug adapters: persist every power step to the
    event log (docs/05 — each mains switch must be auditable)."""

    async def write(data: dict[str, Any]) -> None:
        async with SessionLocal() as session:
            session.add(Event(
                device_id=device_id,
                event_type="power",
                ts_utc=iso_utc_now(),
                source="command",
                data=data,
                dedupe_key=None,
            ))
            await session.commit()

    return write


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.cathq_auth_token in ("", "change-me"):
        # Fail closed: "change-me" is in the public repo and these routes
        # move real hardware. A warning that scrolls by is not a defense.
        raise RuntimeError(
            "CATHQ_AUTH_TOKEN is unset or still the default — refusing to "
            "start. Generate one: openssl rand -hex 32 (put it in .env)"
        )
    await init_db()
    hub = Hub()
    await hub.start()
    adapters: dict[str, DeviceAdapter] = {}
    if settings.whisker_email and settings.whisker_password:
        litterrobot = LitterRobotAdapter(
            email=settings.whisker_email, password=settings.whisker_password
        )
        adapters["litterrobot"] = litterrobot
    else:
        logger.info("litterrobot adapter not configured (no WHISKER_* in .env)")
    if settings.petlibro_email and settings.petlibro_password:
        # NB: Petlibro allows ONE session per account — this login kicks any
        # phone app logged into the same account. Use the dedicated account.
        adapters["feeder"] = PetlibroAdapter(
            email=settings.petlibro_email,
            password=settings.petlibro_password,
            tz=settings.tz,
        )
    else:
        logger.info("feeder adapter not configured (no PETLIBRO_* in .env)")
    if settings.govee_api_key:
        # One adapter per EXPLICITLY bound plug (docs/05 mains-safety rule:
        # commands are refused for anything not named in GOVEE_PLUG_*).
        plug_bindings = {
            "plug_litterrobot": settings.govee_plug_litterrobot,
            "plug_feeder": settings.govee_plug_feeder,
        }
        for plug_id, plug_name in plug_bindings.items():
            if not plug_name:
                continue
            plug = GoveePlugAdapter(
                device_id=plug_id,
                plug_name=plug_name,
                api_key=settings.govee_api_key,
                cycle_delay_s=settings.power_cycle_delay_s,
            )
            plug.on_event = _power_event_writer(plug_id)
            adapters[plug_id] = plug
        if not any(plug_bindings.values()):
            logger.info("GOVEE_API_KEY set but no plugs bound (GOVEE_PLUG_* empty)")
    else:
        logger.info("govee plug adapters not configured (no GOVEE_API_KEY in .env)")
    for device_id, adapter in adapters.items():
        adapter.on_refresh = _hub_notifier(device_id, adapter, hub)
        # start() never raises — connect failures land in the health badge.
        await adapter.start()
    app.state.adapters = adapters
    app.state.hub = hub
    recorder = Recorder(adapters, SessionLocal)
    await recorder.start()
    yield
    await recorder.stop()
    for adapter in adapters.values():
        await adapter.stop()
    await hub.stop()
    await dispose_db()


# openapi/docs off unless ENABLE_DOCS=true: the schema is a free map of the
# hardware-actuating control surface, and nothing in production needs it.
app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    lifespan=lifespan,
    openapi_url="/openapi.json" if settings.enable_docs else None,
)
# M5: everything that reads device data or moves hardware requires the bearer
# token. /health and the static PWA shell stay open (the shell contains no
# data; the token gates every API call the shell makes).
app.include_router(devices.router, dependencies=[Depends(require_auth)])
app.include_router(events.router, dependencies=[Depends(require_auth)])
app.include_router(ws.router)  # WS authenticates inside the handshake

# Frontend build output — present in the Docker image (multi-stage build),
# absent in the bare dev loop (use `npm run dev` + Vite proxy instead).
STATIC_DIR = Path(__file__).resolve().parent / "static"

# index.html/sw.js/manifest must revalidate every load (a stale service
# worker is the classic self-inflicted PWA outage); hashed /assets are
# immutable by construction.
_NO_CACHE = "no-cache"
_IMMUTABLE = "public, max-age=31536000, immutable"


def _static_response(path: str) -> FileResponse | None:
    candidate = (STATIC_DIR / path).resolve()
    if not candidate.is_relative_to(STATIC_DIR) or not candidate.is_file():
        return None
    # Cache policy keys off the RESOLVED location, not the raw request path:
    # /assets/../index.html must never be stamped immutable.
    rel = candidate.relative_to(STATIC_DIR).as_posix()
    cache = _IMMUTABLE if rel.startswith("assets/") else _NO_CACHE
    return FileResponse(candidate, headers={"Cache-Control": cache})


@app.get("/", include_in_schema=False)
def root():
    index = _static_response("index.html")
    if index is not None:
        return index
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
            "govee": bool(settings.govee_api_key),
            "tapo": bool(settings.tapo_cam_ip),
        },
        "adapters": {
            name: (await adapter.health()).model_dump(mode="json")
            for name, adapter in adapters.items()
        },
    }


# Registered LAST: every earlier route (API + /health) wins; anything else is
# a static file or an SPA navigation → index.html. 404 with no frontend build.
@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    response = _static_response(path)
    if response is not None:
        return response
    # File-looking misses (hashed assets, icons, sw.js…) must 404 — a 200
    # index.html here poisons caches and masks build/deploy mistakes. Only
    # extensionless paths are SPA navigations.
    if path.startswith("assets/") or "." in path.rsplit("/", 1)[-1]:
        raise HTTPException(status_code=404)
    index = _static_response("index.html")
    if index is not None:
        return index
    raise HTTPException(status_code=404)
