"""POST /care — owner-logged care events (M5.7 follow-on, 2026-07-06).

Brushing, nail trims, evening playtime, pets: the recurring care no device
can see. Rows land in the SAME event log (device_id='care',
event_type='care', source='owner') so the Diary, the reminders card, and any
future insight read them like everything else — no new tables, no new
storage. Additive and tiny by design (docs/06 T7 spirit); cadence rules
(daily/monthly/3-a-day) live client-side where the LA-timezone helpers are.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

# Late-bound via the module attribute (db.SessionLocal) so the test suite's
# per-test in-memory engine patch (conftest monkeypatches app.db) applies here
# without needing another per-module patch entry.
from .. import db
from ..models import Event, EventOut, iso_utc_now

router = APIRouter(tags=["care"])

# The four owner-defined tasks (2026-07-06). Adding one = extend this Literal
# and the frontend's CARE_TASKS list.
CareTask = Literal["brush", "nails", "play", "pet", "water"]


class CareLogIn(BaseModel):
    task: CareTask


@router.post("/care")
async def log_care(body: CareLogIn):
    """Append one care event, timestamped now. Returns the stored row."""
    row = Event(
        device_id="care",
        event_type="care",
        ts_utc=iso_utc_now(),
        source="owner",
        data={"task": body.task},
        dedupe_key=None,
    )
    async with db.SessionLocal() as session:
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return EventOut.model_validate(row).model_dump()
