"""Recorder: turns adapter state into persisted events (M3).

Two loops, both crash-proof (an iteration failure logs and the loop keeps
going — the recorder must never take polling or the API down):

- STATE loop (~60s + jitter): samples each adapter's in-memory state (the
  adapters already poll the vendors; this adds ZERO vendor traffic), diffs
  against the previous sample, writes change events and upserts the
  latest-state snapshot. The baseline is seeded from the DB at startup so
  changes across a backend restart are still detected (M3 acceptance).

- HISTORY loop (~10 min + jitter): ingests vendor history (Litter-Robot
  activity, feeder work records) idempotently via UNIQUE dedupe keys —
  authoritative events even for windows where the backend was down. This
  costs one extra cloud call per device per cycle, well inside the
  CLAUDE.md politeness budget.
"""
from __future__ import annotations

import asyncio
import logging
import random
from contextlib import suppress
from typing import Any

from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .adapters.base import DeviceAdapter
from .models import DeviceStateRow, Event, iso_utc_now, normalize_iso

logger = logging.getLogger(__name__)

STATE_INTERVAL_S = 60
HISTORY_INTERVAL_S = 600
HISTORY_INITIAL_DELAY_S = 20
HISTORY_FETCH_LIMIT = 50

# attribute → event_type, per device. Events carry {field, from, to}.
TRACKED_FIELDS: dict[str, dict[str, str]] = {
    "litterrobot": {
        "status_code": "status_change",
        "is_online": "connectivity",
        "waste_drawer_level_pct": "drawer_level_change",
        "is_waste_drawer_full": "drawer_full",
        "litter_level_state": "litter_level_change",
        "pet_weight_lbs": "pet_weight",
    },
    "feeder": {
        "online": "connectivity",
        "food_low": "food_low",
        "dispenser_blocked": "dispenser_blocked",
        "running_state": "running_state",
        "today_feed_count": "feed_count_change",
    },
}


class Recorder:
    def __init__(self, adapters: dict[str, DeviceAdapter], session_factory) -> None:
        self._adapters = adapters
        self._session_factory = session_factory
        self._prev_attrs: dict[str, dict[str, Any]] = {}
        self._prev_health: dict[str, str] = {}
        self._tasks: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        if not self._adapters:
            logger.info("recorder idle: no adapters configured")
            return
        self._tasks = [
            asyncio.create_task(self._state_loop(), name="recorder-state"),
            asyncio.create_task(self._history_loop(), name="recorder-history"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks = []

    # ── state loop ───────────────────────────────────────────────────────

    async def _state_loop(self) -> None:
        try:
            await self._seed_baseline()
        except Exception:  # noqa: BLE001
            logger.exception("recorder baseline seed failed; starting cold")
        while True:
            try:
                await self._sample_all()
            except Exception:  # noqa: BLE001 — recorder must never die
                logger.exception("recorder state sample failed")
            await asyncio.sleep(STATE_INTERVAL_S * random.uniform(0.9, 1.15))

    async def _seed_baseline(self) -> None:
        """Load the last persisted snapshots so a restart diffs against them
        instead of silently re-baselining."""
        from sqlalchemy import select

        async with self._session_factory() as session:
            rows = (await session.execute(select(DeviceStateRow))).scalars().all()
        for row in rows:
            self._prev_attrs[row.device_id] = dict(row.attributes)
            status = (row.health or {}).get("status")
            if status:
                self._prev_health[row.device_id] = status
        if rows:
            logger.info(
                "recorder baseline seeded from DB: %s",
                ", ".join(r.device_id for r in rows),
            )

    async def _sample_all(self) -> None:
        now = iso_utc_now()
        events: list[dict[str, Any]] = []
        snapshots: list[dict[str, Any]] = []

        for device_id, adapter in self._adapters.items():
            health = await adapter.health()
            health_json = health.model_dump(mode="json")

            prev_status = self._prev_health.get(device_id)
            if prev_status is not None and prev_status != health.status.value:
                events.append({
                    "device_id": device_id,
                    "event_type": "health_change",
                    "ts_utc": now,
                    "source": "poll",
                    "data": {
                        "from": prev_status,
                        "to": health.status.value,
                        "detail": health.detail,
                    },
                    "dedupe_key": None,
                })
            self._prev_health[device_id] = health.status.value

            if not adapter.connected:
                continue  # health said it loudly; nothing to snapshot
            attrs = (await adapter.get_state()).attributes
            prev = self._prev_attrs.get(device_id)
            if prev is not None:
                for field, event_type in TRACKED_FIELDS.get(device_id, {}).items():
                    if field in attrs and prev.get(field) != attrs[field]:
                        events.append({
                            "device_id": device_id,
                            "event_type": event_type,
                            "ts_utc": now,
                            "source": "poll",
                            "data": {
                                "field": field,
                                "from": prev.get(field),
                                "to": attrs[field],
                            },
                            "dedupe_key": None,
                        })
            self._prev_attrs[device_id] = dict(attrs)
            snapshots.append({
                "device_id": device_id,
                "updated_at_utc": now,
                "attributes": attrs,
                "health": health_json,
            })

        if not events and not snapshots:
            return
        async with self._session_factory() as session:
            if events:
                await session.execute(sqlite_insert(Event), events)
            for snap in snapshots:
                stmt = (
                    sqlite_insert(DeviceStateRow)
                    .values(**snap)
                    .on_conflict_do_update(
                        index_elements=[DeviceStateRow.device_id],
                        set_={
                            "updated_at_utc": snap["updated_at_utc"],
                            "attributes": snap["attributes"],
                            "health": snap["health"],
                        },
                    )
                )
                await session.execute(stmt)
            await session.commit()

    # ── history loop ─────────────────────────────────────────────────────

    async def _history_loop(self) -> None:
        await asyncio.sleep(HISTORY_INITIAL_DELAY_S)
        while True:
            try:
                await self._ingest_history()
            except Exception:  # noqa: BLE001 — recorder must never die
                logger.exception("recorder history ingest failed")
            await asyncio.sleep(HISTORY_INTERVAL_S * random.uniform(0.9, 1.1))

    async def _ingest_history(self) -> None:
        rows: list[dict[str, Any]] = []

        litterrobot = self._adapters.get("litterrobot")
        if litterrobot is not None and litterrobot.connected:
            try:
                for a in await litterrobot.get_activity(limit=HISTORY_FETCH_LIMIT):
                    ts = normalize_iso(a["timestamp_utc"])
                    rows.append({
                        "device_id": "litterrobot",
                        "event_type": "activity",
                        "ts_utc": ts,
                        "source": "history",
                        "data": {"action": a["action"]},
                        "dedupe_key": f"lr:{ts}:{a['action'][:100]}",
                    })
            except Exception as err:  # noqa: BLE001 — one vendor down ≠ both
                logger.warning("litterrobot history ingest failed: %s", err)

        feeder = self._adapters.get("feeder")
        if feeder is not None and feeder.connected:
            try:
                for e in await feeder.get_feed_log(days=2, limit=HISTORY_FETCH_LIMIT):
                    if not e["timestamp_utc"]:
                        continue
                    ts = normalize_iso(e["timestamp_utc"])
                    rows.append({
                        "device_id": "feeder",
                        "event_type": "feed",
                        "ts_utc": ts,
                        "source": "history",
                        "data": {"portions": e["portions"]},
                        "dedupe_key": f"pl:{ts}:{e['portions']}",
                    })
            except Exception as err:  # noqa: BLE001
                logger.warning("feeder history ingest failed: %s", err)

        if not rows:
            return
        async with self._session_factory() as session:
            stmt = sqlite_insert(Event).on_conflict_do_nothing(
                index_elements=[Event.dedupe_key]
            )
            await session.execute(stmt, rows)
            await session.commit()
        logger.debug("history ingest: %d candidate rows", len(rows))
