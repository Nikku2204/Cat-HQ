"""Device endpoints (M1: Litter-Robot, M2: Petlibro feeder). Camera at M6.

Error mapping:
- adapter missing (no creds in .env)      → 404
- adapter present but not connected       → 503 with health detail
- cloud/transient failure during the call → 502
- vendor cloud rejected a command         → 502
"""
from __future__ import annotations

import aiohttp
from botocore.exceptions import BotoCoreError
from botocore.exceptions import ClientError as CognitoClientError
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pylitterbot.exceptions import LitterRobotException

from ..adapters.base import Command
from ..adapters.litterrobot import LitterRobotAdapter
from ..adapters.petlibro import PetlibroAdapter
from ..adapters.petlibro.client import (
    MAX_FEED_PORTIONS,
    PetlibroError,
    PetlibroSessionError,
)

router = APIRouter(prefix="/devices", tags=["devices"])

# botocore errors leak from pylitterbot's Cognito token refresh — map them to
# 502 like any other cloud failure instead of a raw 500.
CLOUD_ERRORS = (
    LitterRobotException,
    aiohttp.ClientError,
    TimeoutError,
    BotoCoreError,
    CognitoClientError,
    KeyError,  # pylitterbot's Cognito error handler can KeyError internally
)
FEEDER_CLOUD_ERRORS = (PetlibroError, aiohttp.ClientError, TimeoutError)


def _litterrobot(request: Request) -> LitterRobotAdapter:
    adapter = request.app.state.adapters.get("litterrobot")
    if adapter is None:
        raise HTTPException(
            status_code=404,
            detail="litterrobot adapter not configured — "
            "set WHISKER_EMAIL/WHISKER_PASSWORD in .env",
        )
    return adapter


async def _connected_or_503(adapter: LitterRobotAdapter) -> None:
    if not adapter.connected:
        health = await adapter.health()
        raise HTTPException(
            status_code=503,
            detail=f"litterrobot adapter not connected: {health.detail}",
        )


@router.get("/litterrobot")
async def litterrobot_state(request: Request):
    """Current state + adapter health. State is null while disconnected —
    never silently stale (01-ARCHITECTURE.md #4)."""
    adapter = _litterrobot(request)
    health = await adapter.health()
    state = None
    if adapter.connected:
        state = (await adapter.get_state()).model_dump(mode="json")
    return {"health": health.model_dump(mode="json"), "state": state}


@router.post("/litterrobot/clean")
async def litterrobot_clean(request: Request):
    """Trigger a clean cycle. Moves the physical globe."""
    adapter = _litterrobot(request)
    await _connected_or_503(adapter)
    try:
        result = await adapter.execute(Command(name="start_clean"))
    except CLOUD_ERRORS as err:
        raise HTTPException(status_code=502, detail=f"whisker cloud error: {err}")
    if not result["accepted"]:
        raise HTTPException(
            status_code=502, detail="Whisker cloud rejected the clean command"
        )
    return result


@router.get("/litterrobot/history")
async def litterrobot_history(
    request: Request, limit: int = Query(default=50, ge=1, le=500)
):
    """Recent activity (cycles, cat visits with weight, faults), newest first."""
    adapter = _litterrobot(request)
    await _connected_or_503(adapter)
    try:
        activities = await adapter.get_activity(limit=limit)
    except CLOUD_ERRORS as err:
        raise HTTPException(status_code=502, detail=f"whisker cloud error: {err}")
    return {"count": len(activities), "activities": activities}


# ── Petlibro feeder (M2) ─────────────────────────────────────────────────


class FeedRequest(BaseModel):
    portions: int = Field(default=1, ge=1, le=MAX_FEED_PORTIONS)


def _feeder(request: Request) -> PetlibroAdapter:
    adapter = request.app.state.adapters.get("feeder")
    if adapter is None:
        raise HTTPException(
            status_code=404,
            detail="feeder adapter not configured — "
            "set PETLIBRO_EMAIL/PETLIBRO_PASSWORD in .env",
        )
    return adapter


async def _feeder_connected_or_503(adapter: PetlibroAdapter) -> None:
    if not adapter.connected:
        health = await adapter.health()
        raise HTTPException(
            status_code=503,
            detail=f"feeder adapter not connected: {health.detail}",
        )


@router.get("/feeder")
async def feeder_state(request: Request):
    """Current feeder state + adapter health. State is null while
    disconnected — never silently stale."""
    adapter = _feeder(request)
    health = await adapter.health()
    state = None
    if adapter.connected:
        state = (await adapter.get_state()).model_dump(mode="json")
    return {"health": health.model_dump(mode="json"), "state": state}


@router.post("/feeder/feed")
async def feeder_feed(request: Request, body: FeedRequest | None = None):
    """Dispense food (1 portion ≈ 1/12 cup). NOT auto-retried on session
    loss — if you get a 502/503, check the feed log before pressing again."""
    adapter = _feeder(request)
    await _feeder_connected_or_503(adapter)
    portions = (body or FeedRequest()).portions
    try:
        result = await adapter.execute(
            Command(name="manual_feed", params={"portions": portions})
        )
    except PetlibroSessionError as err:
        raise HTTPException(status_code=503, detail=f"petlibro session lost: {err}")
    except FEEDER_CLOUD_ERRORS as err:
        raise HTTPException(status_code=502, detail=f"petlibro cloud error: {err}")
    return result


@router.get("/feeder/history")
async def feeder_history(
    request: Request,
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=50, ge=1, le=500),
):
    """Successful dispenses (manual + scheduled), newest first."""
    adapter = _feeder(request)
    await _feeder_connected_or_503(adapter)
    try:
        events = await adapter.get_feed_log(days=days, limit=limit)
    except PetlibroSessionError as err:
        raise HTTPException(status_code=503, detail=f"petlibro session lost: {err}")
    except FEEDER_CLOUD_ERRORS as err:
        raise HTTPException(status_code=502, detail=f"petlibro cloud error: {err}")
    return {"count": len(events), "events": events}
