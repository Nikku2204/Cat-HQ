"""Device endpoints (M1: Litter-Robot). Petlibro joins at M2, camera at M6.

Error mapping:
- adapter missing (no creds in .env)      → 404
- adapter present but not connected       → 503 with health detail
- cloud/transient failure during the call → 502
- Whisker cloud rejected a command        → 502
"""
from __future__ import annotations

import aiohttp
from fastapi import APIRouter, HTTPException, Query, Request
from pylitterbot.exceptions import LitterRobotException

from ..adapters.base import Command
from ..adapters.litterrobot import LitterRobotAdapter

router = APIRouter(prefix="/devices", tags=["devices"])

CLOUD_ERRORS = (LitterRobotException, aiohttp.ClientError, TimeoutError)


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
