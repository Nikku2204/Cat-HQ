"""Petlibro PLAF103 Granary feeder adapter (M2).

Uses the ported GPL client in client.py. Same shape as the litterrobot
adapter: poll every ~60s with jitter/backoff, fail loudly into health().

Single-session rule: the client enforces single-flight logins with a
cooldown; this adapter NEVER forces extra logins. If the session is being
contested (owner's phone app on the same account), health goes DEGRADED
with a message saying exactly that.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from contextlib import suppress
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

from ..base import AdapterHealth, Command, DeviceAdapter, DeviceState, HealthStatus
from .client import (
    MAX_FEED_PORTIONS,
    PetlibroAPIError,
    PetlibroAuthError,
    PetlibroClient,
    PetlibroError,
    PetlibroHTTPError,
    PetlibroSessionError,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 60          # CLAUDE.md cadence: ~60s with jitter
MAX_BACKOFF_S = 600
REQUEST_TIMEOUT_S = 45        # cap one whole poll pass
ERROR_AFTER_FAILURES = 5

GRANARY_PRODUCT_NAME = "Granary Smart Feeder"  # upstream dispatch key
PLAF103_IDENTIFIER = "PLAF103"

# Transient → DEGRADED + backoff. PetlibroAuthError is NOT here: bad creds
# stop the loop (never retry-loop a login against a single-session cloud).
TRANSIENT_ERRORS = (
    PetlibroHTTPError,
    PetlibroAPIError,
    PetlibroSessionError,
    aiohttp.ClientError,
    TimeoutError,
)


class PetlibroAdapter(DeviceAdapter):
    device_id = "feeder"
    device_type = "feeder"

    def __init__(self, email: str, password: str, tz: str) -> None:
        self._client = PetlibroClient(email=email, password=password, tz=tz)
        self._tz = tz
        self._serial: str | None = None
        self._static: dict[str, Any] = {}   # from device_list/baseInfo
        self._live: dict[str, Any] = {}     # last good poll: state attributes
        self._device_online = True
        self._poll_task: asyncio.Task[None] | None = None
        # health bookkeeping
        self._status = HealthStatus.UNCONFIGURED
        self._detail = "not started"
        self._last_success: datetime | None = None
        self._failures = 0

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Login, find the feeder, first poll, start the loop. Never raises."""
        self._status, self._detail = HealthStatus.DEGRADED, "connecting"
        try:
            await self._connect_and_poll()
            self._mark_success("connected")
        except PetlibroAuthError as err:
            self._set_error(f"login failed: {err}")
            logger.error(
                "Petlibro login failed — check PETLIBRO_EMAIL/PETLIBRO_PASSWORD"
            )
            return  # bad creds: no loop, no hammering
        except TRANSIENT_ERRORS as err:
            self._mark_failure(f"initial connect failed: {err}")
            logger.warning("Petlibro initial connect failed, will retry: %s", err)
        self._poll_task = asyncio.create_task(self._poll_loop(), name="feeder-poll")

    async def stop(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        # No cloud logout on purpose: upstream never calls it, and an explicit
        # logout buys nothing for the single-session dance.
        await self._client.close()

    async def _connect_and_poll(self) -> None:
        """Ensure login + device discovery, then one full state poll."""
        async with asyncio.timeout(REQUEST_TIMEOUT_S):
            if not self._client.logged_in:
                await self._client.login()
            if self._serial is None:
                await self._discover()
            await self._poll_once()

    async def _discover(self) -> None:
        devices = await self._client.device_list()
        if not devices:
            raise PetlibroAPIError(
                None,
                "no devices on this Petlibro account — is the feeder shared "
                "to the dedicated account?",
            )
        granary = [
            d for d in devices
            if d.get("productName") == GRANARY_PRODUCT_NAME
            or d.get("productIdentifier") == PLAF103_IDENTIFIER
        ]
        chosen = granary[0] if granary else devices[0]
        if not granary:
            logger.warning(
                "no PLAF103/Granary matched; using first device %r (%s)",
                chosen.get("name"), chosen.get("productIdentifier"),
            )
        elif len(granary) > 1:
            logger.warning("multiple Granary feeders; using %s", chosen.get("deviceSn"))
        self._serial = chosen["deviceSn"]
        self._static = {
            "serial": chosen.get("deviceSn"),
            "name": chosen.get("name"),
            "model": chosen.get("productIdentifier"),
            "product_name": chosen.get("productName"),
            "mac": chosen.get("mac"),
            "firmware": chosen.get("softwareVersion"),
            "hardware": chosen.get("hardwareVersion"),
            # 1 = shared with this account, 2 = owned+shared, 3 = owned
            "share_state": chosen.get("deviceShareState"),
        }

    async def _poll_once(self) -> None:
        """One full state fetch. Raises on any API/transport failure."""
        assert self._serial is not None
        real = await self._client.real_info(self._serial)
        grain = await self._client.grain_status(self._serial)
        today = await self._client.feeding_plan_today(self._serial)
        next_feed: dict[str, Any] | None = None
        if real.get("enableFeedingPlan"):
            plans = await self._client.feeding_plans(self._serial)
            next_feed = self._compute_next_feed(plans)

        electric = real.get("electricQuantity")
        self._device_online = bool(real.get("online", False))
        self._live = {
            **self._static,
            "online": self._device_online,
            "running_state": real.get("runningState", "IDLE"),
            # both flags are inverted upstream: True from the API means "fine"
            "food_low": not bool(real.get("surplusGrain", True)),
            "dispenser_blocked": not bool(real.get("grainOutletState", True)),
            "battery_state": real.get("batteryState", "unknown"),
            "battery_pct": int(electric) if electric is not None else None,
            "wifi_ssid": real.get("wifiSsid"),
            "wifi_rssi": real.get("wifiRssi", -100),
            "feeding_plan_enabled": bool(real.get("enableFeedingPlan", False)),
            "child_lock": bool(real.get("childLockSwitch", False)),
            "sound_enabled": bool(real.get("enableSound", False)),
            "light_enabled": bool(real.get("enableLight", False)),
            # 1 cup / 2 oz / 3 g / 4 mL; Granary default 1 (portions ≈ 1/12 cup)
            "unit_type": real.get("unitType", 1),
            "today_portions": grain.get("todayFeedingQuantity", 0),
            "today_feed_count": grain.get("todayFeedingTimes", 0),
            "today_portion_list": grain.get("todayFeedingQuantities", []),
            "today_all_skipped": bool(today.get("allSkipped", False)),
            "next_feed_time_utc": next_feed["time_utc"] if next_feed else None,
            "next_feed_portions": next_feed["portions"] if next_feed else None,
        }

    def _compute_next_feed(self, plans: list[dict]) -> dict[str, Any] | None:
        """Next enabled scheduled feed across plans (each plan carries its own
        IANA timezone; repeatDay is a STRINGIFIED list like "[1,2,3]" of ISO
        weekdays). Dashboard sugar — parse failures log and return None rather
        than killing the poll."""
        best: tuple[datetime, int] | None = None
        now_utc = datetime.now(timezone.utc)
        for plan in plans:
            try:
                if not plan.get("enable") or ":" not in str(plan.get("executionTime", "")):
                    continue
                hour, minute = map(int, str(plan["executionTime"]).split(":")[:2])
                tz = ZoneInfo(plan.get("timezone") or self._tz)
                raw_days = str(plan.get("repeatDay") or "[]")
                days = json.loads(raw_days) or list(range(1, 8))
                local_now = now_utc.astimezone(tz)
                for offset in range(8):
                    day = (local_now + timedelta(days=offset)).date()
                    if day.isoweekday() not in days:
                        continue
                    candidate = datetime.combine(day, dtime(hour, minute), tzinfo=tz)
                    if candidate <= local_now:
                        continue
                    cand_utc = candidate.astimezone(timezone.utc)
                    if best is None or cand_utc < best[0]:
                        best = (cand_utc, int(plan.get("grainNum") or 0))
                    break
            except Exception as err:  # noqa: BLE001 — sugar, not state
                logger.warning("could not parse feeding plan %r: %s", plan.get("id"), err)
        if best is None:
            return None
        return {"time_utc": best[0].isoformat(), "portions": best[1]}

    async def _poll_loop(self) -> None:
        delay: float = POLL_INTERVAL_S
        while True:
            await asyncio.sleep(delay * random.uniform(0.9, 1.1))
            try:
                await self._connect_and_poll()
                self._mark_success("polled")
                delay = POLL_INTERVAL_S
            except PetlibroAuthError as err:
                self._set_error(f"login failed: {err}")
                logger.error(
                    "Petlibro credentials rejected; poll loop stopped — "
                    "fix .env and restart"
                )
                return
            except PetlibroSessionError as err:
                # Session contested (phone app?) or cooldown active. Keep the
                # normal cadence — the client will retry ONE login next cycle.
                self._mark_failure(f"session contested: {err}")
                delay = POLL_INTERVAL_S
                logger.warning("Petlibro session contested: %s", err)
            except TRANSIENT_ERRORS as err:
                self._mark_failure(f"poll failed: {err}")
                delay = min(delay * 2, MAX_BACKOFF_S)
                logger.warning(
                    "Petlibro poll failed (%d in a row, next try ~%ds): %s",
                    self._failures, int(delay), err,
                )
            except Exception as err:  # noqa: BLE001 — unexpected: loud, retry slowly
                self._set_error(f"unexpected error: {err!r}")
                delay = MAX_BACKOFF_S
                logger.exception("unexpected error in feeder poll loop")

    # ── DeviceAdapter interface ──────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._serial is not None and bool(self._live)

    async def get_state(self) -> DeviceState:
        if not self.connected:
            raise RuntimeError("feeder adapter is not connected")
        return DeviceState(
            device_id=self.device_id,
            device_type=self.device_type,
            fetched_at_utc=self._last_success or datetime.now(timezone.utc),
            attributes=dict(self._live),
        )

    async def execute(self, command: Command) -> dict[str, Any]:
        if self._serial is None:
            raise RuntimeError("feeder adapter is not connected")
        if command.name == "manual_feed":
            portions = int(command.params.get("portions", 1))
            if not 1 <= portions <= MAX_FEED_PORTIONS:
                raise ValueError(f"portions must be 1..{MAX_FEED_PORTIONS}")
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    result = await self._client.manual_feed(self._serial, portions)
            except TRANSIENT_ERRORS as err:
                self._mark_failure(f"manual_feed failed: {err}")
                raise
            self._mark_success(f"manual_feed({portions}) accepted")
            # data is a bare int upstream, semantics undocumented — pass along
            return {"command": "manual_feed", "portions": portions, "result": result}
        raise ValueError(f"unknown command for feeder: {command.name!r}")

    async def health(self) -> AdapterHealth:
        status = self._status
        if status is HealthStatus.DEGRADED and self._failures >= ERROR_AFTER_FAILURES:
            status = HealthStatus.ERROR
        detail = self._detail
        if status is HealthStatus.OK and not self._device_online:
            # Cloud reachable but the feeder itself is off/unplugged/off-wifi.
            status = HealthStatus.DEGRADED
            detail = "feeder reports offline (check power/wifi)"
        return AdapterHealth(
            status=status,
            detail=detail,
            last_success_utc=self._last_success,
            consecutive_failures=self._failures,
        )

    # ── extras used by the API layer ─────────────────────────────────────

    async def get_feed_log(
        self, days: int = 7, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Successful dispenses, flattened from the API's day-buckets."""
        if self._serial is None:
            raise RuntimeError("feeder adapter is not connected")
        try:
            async with asyncio.timeout(REQUEST_TIMEOUT_S):
                buckets = await self._client.work_records(
                    self._serial, days=days, size=limit
                )
        except TRANSIENT_ERRORS as err:
            self._mark_failure(f"feed log fetch failed: {err}")
            raise
        self._mark_success("feed log fetched")
        events: list[dict[str, Any]] = []
        for bucket in buckets:
            for rec in bucket.get("workRecords", []) or []:
                if rec.get("type") != "GRAIN_OUTPUT_SUCCESS":
                    continue
                ts = rec.get("recordTime")
                events.append({
                    "timestamp_utc": (
                        datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
                        if ts else None
                    ),
                    "portions": int(rec.get("actualGrainNum") or 0),
                    "type": rec.get("type"),
                })
        return events

    # ── health bookkeeping ───────────────────────────────────────────────

    def _mark_success(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.OK, detail
        self._last_success = datetime.now(timezone.utc)
        self._failures = 0

    def _mark_failure(self, detail: str) -> None:
        self._failures += 1
        self._status, self._detail = HealthStatus.DEGRADED, detail

    def _set_error(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.ERROR, detail
