"""GET /events — query the normalized event log (M3)."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from ..db import SessionLocal
from ..models import Event, EventOut, normalize_iso

router = APIRouter(tags=["events"])

KNOWN_DEVICES = {"litterrobot", "feeder"}


@router.get("/events")
async def list_events(
    device: str | None = Query(default=None, description="litterrobot | feeder"),
    event_type: str | None = Query(default=None, alias="type"),
    since: datetime | None = Query(default=None, description="ISO timestamp"),
    until: datetime | None = Query(default=None, description="ISO timestamp"),
    limit: int = Query(default=100, ge=1, le=1000),
):
    """Newest-first event log with device/type/time filters."""
    if device is not None and device not in KNOWN_DEVICES:
        raise HTTPException(
            status_code=422, detail=f"unknown device {device!r}; try {sorted(KNOWN_DEVICES)}"
        )
    stmt = select(Event).order_by(Event.ts_utc.desc(), Event.id.desc()).limit(limit)
    if device is not None:
        stmt = stmt.where(Event.device_id == device)
    if event_type is not None:
        stmt = stmt.where(Event.event_type == event_type)
    if since is not None:
        stmt = stmt.where(Event.ts_utc >= normalize_iso(since))
    if until is not None:
        stmt = stmt.where(Event.ts_utc <= normalize_iso(until))
    async with SessionLocal() as session:
        events = (await session.execute(stmt)).scalars().all()
    return {
        "count": len(events),
        "events": [EventOut.model_validate(e).model_dump() for e in events],
    }
