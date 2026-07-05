"""Litter-Robot 4 adapter — wraps pylitterbot (M1).

Connection model (verified against pylitterbot 2025.6.1 source and the HA
litterrobot integration, 2026-07-05):
- login once (Cognito), then poll `robot.refresh()` every ~60s with jitter
  and exponential backoff. Token refresh is automatic inside the library.
- IMPORTANT: poll `robot.refresh()`, NOT `account.refresh_robots()` /
  `load_robots()` — the account-level helpers catch-and-log network errors
  internally, which would leave health() green over stale data (violates
  fail-loud, 01-ARCHITECTURE.md #4).
- websocket push (`subscribe_for_updates=True`) is deliberately deferred to
  M3/M4 when the app grows its own WebSocket broadcast channel; the upgrade
  path is HA's: re-run load_robots(subscribe_for_updates=True) each poll and
  relax the poll to a 5-min reconcile.
- LitterRobotLoginException mid-flight → tear down and re-login ONCE; if auth
  fails twice in a row, stop polling and surface ERROR (never retry-loop bad
  credentials against Cognito).
- Raw aiohttp errors and timeouts DO escape robot-level calls (only the
  account-level helpers wrap them) → DEGRADED with backoff.
- KeyError from connect(): pylitterbot's Cognito error handler reads
  err.response['message'], which can itself KeyError for some botocore error
  shapes → treat as a login failure.
"""
from __future__ import annotations

import asyncio
import logging
import random
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any

import aiohttp
from pylitterbot import Account, LitterRobot4
from pylitterbot.enums import LitterBoxStatus
from pylitterbot.exceptions import LitterRobotException, LitterRobotLoginException

from .base import AdapterHealth, Command, DeviceAdapter, DeviceState, HealthStatus

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 60          # CLAUDE.md cadence: ~60s with jitter
MAX_BACKOFF_S = 600           # never tight-loop the Whisker cloud
REQUEST_TIMEOUT_S = 45        # cap a single refresh so the loop stays alive
ERROR_AFTER_FAILURES = 5      # consecutive failures before DEGRADED→ERROR

# Errors that mean "cloud/transient" — backoff and retry.
TRANSIENT_ERRORS = (LitterRobotException, aiohttp.ClientError, TimeoutError)


class LitterRobotAdapter(DeviceAdapter):
    device_id = "litterrobot"
    device_type = "litterrobot"

    def __init__(self, email: str, password: str) -> None:
        self._email = email
        self._password = password
        self._account: Account | None = None
        self._robot: LitterRobot4 | None = None
        self._poll_task: asyncio.Task[None] | None = None
        # health bookkeeping (assembled on demand in health())
        self._status = HealthStatus.UNCONFIGURED
        self._detail = "not started"
        self._last_success: datetime | None = None
        self._failures = 0
        self._login_failures = 0

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Connect and start polling. Never raises — a failed first connect
        lands in health(); unless credentials are bad, the poll loop keeps
        retrying in the background."""
        self._status, self._detail = HealthStatus.DEGRADED, "connecting"
        try:
            await self._connect()
            self._mark_success("connected")
        except (LitterRobotLoginException, KeyError) as err:
            self._set_error(f"login failed: {err}")
            logger.error("Whisker login failed — check WHISKER_EMAIL/WHISKER_PASSWORD")
            return  # wrong creds from the get-go: don't hammer Cognito
        except TRANSIENT_ERRORS as err:
            self._mark_failure(f"initial connect failed: {err}")
            logger.warning("Whisker initial connect failed, will retry: %s", err)
        self._poll_task = asyncio.create_task(
            self._poll_loop(), name="litterrobot-poll"
        )

    async def stop(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        await self._teardown_account()

    async def _teardown_account(self) -> None:
        account, self._account, self._robot = self._account, None, None
        if account is not None:
            try:
                await account.disconnect()  # closes the session it created
            except Exception as err:  # noqa: BLE001 — teardown must not raise
                logger.warning("error disconnecting Whisker account: %s", err)

    async def _connect(self) -> None:
        """Log in and load robots. Caller handles exceptions."""
        await self._teardown_account()  # drop any half-dead previous session
        account = Account()
        try:
            await account.connect(
                username=self._email,
                password=self._password,
                load_robots=True,
                subscribe_for_updates=False,  # M1: poll-only; push arrives M3/M4
            )
            robots = account.get_robots(LitterRobot4)
            if not robots:
                raise LitterRobotException(
                    "no Litter-Robot 4 found on this Whisker account"
                )
        except BaseException:
            with suppress(Exception):
                await account.disconnect()
            raise
        if len(robots) > 1:
            logger.warning(
                "multiple Litter-Robot 4s on account; using %s", robots[0].serial
            )
        self._account, self._robot = account, robots[0]
        self._login_failures = 0

    async def _poll_loop(self) -> None:
        delay: float = POLL_INTERVAL_S
        while True:
            await asyncio.sleep(delay * random.uniform(0.9, 1.1))
            try:
                if self._robot is None:
                    await self._connect()
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    await self._robot.refresh()
                self._mark_success("polled")
                delay = POLL_INTERVAL_S
            except (LitterRobotLoginException, KeyError) as err:
                self._login_failures += 1
                if self._login_failures >= 2:
                    self._set_error(f"login failed: {err}")
                    logger.error(
                        "Whisker re-login failed twice; poll loop stopped — "
                        "fix credentials and restart"
                    )
                    return
                # Token/refresh death mid-flight — one full re-login attempt.
                self._mark_failure(f"auth error, re-login queued: {err}")
                await self._teardown_account()
                delay = 30
            except TRANSIENT_ERRORS as err:
                self._mark_failure(f"poll failed: {err}")
                delay = min(delay * 2, MAX_BACKOFF_S)
                logger.warning(
                    "Whisker poll failed (%d in a row, next try ~%ds): %s",
                    self._failures, int(delay), err,
                )
            except Exception as err:  # noqa: BLE001 — unexpected: loud, keep trying slowly
                self._set_error(f"unexpected error: {err!r}")
                delay = MAX_BACKOFF_S
                logger.exception("unexpected error in litterrobot poll loop")

    # ── DeviceAdapter interface ──────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._robot is not None

    async def get_state(self) -> DeviceState:
        """Read current state off the poll-refreshed Robot object (no I/O)."""
        robot = self._robot
        if robot is None:
            raise RuntimeError("litterrobot adapter is not connected")
        return DeviceState(
            device_id=self.device_id,
            device_type=self.device_type,
            fetched_at_utc=self._last_success or datetime.now(timezone.utc),
            attributes={
                "name": robot.name,
                "serial": robot.serial,
                "model": robot.model,
                "is_online": robot.is_online,
                "is_on": robot.is_on,
                "power_type": robot.power_type,  # AC / DC (battery) / NC
                "status_code": robot.status_code,  # e.g. "RDY", "CCP", "DFS"
                "status_text": robot.status_text,  # e.g. "Ready"
                "is_sleeping": robot.is_sleeping,
                "sleep_mode_enabled": robot.sleep_mode_enabled,
                "waste_drawer_level_pct": robot.waste_drawer_level,
                "is_waste_drawer_full": robot.is_waste_drawer_full,
                "litter_level_pct": robot.litter_level,
                "litter_level_state": (
                    robot.litter_level_state.value
                    if robot.litter_level_state else None
                ),
                "cycle_count": robot.cycle_count,
                "cycle_capacity": robot.cycle_capacity,
                "cycles_after_drawer_full": robot.cycles_after_drawer_full,
                "scoops_saved_count": robot.scoops_saved_count,
                "night_light_mode": (
                    robot.night_light_mode.value
                    if robot.night_light_mode else None
                ),
                "panel_lock_enabled": robot.panel_lock_enabled,
                "pet_weight_lbs": robot.pet_weight,
                "last_seen_utc": (
                    robot.last_seen.isoformat() if robot.last_seen else None
                ),
                "firmware": robot.firmware,
            },
        )

    async def execute(self, command: Command) -> dict[str, Any]:
        robot = self._robot
        if robot is None:
            raise RuntimeError("litterrobot adapter is not connected")
        if command.name == "start_clean":
            # start_cleaning() returns bool: True = cloud accepted the
            # command; False = cloud rejected it (the library logs why, and
            # never raises InvalidCommandException for this no-arg command).
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    accepted = await robot.start_cleaning()
            except TRANSIENT_ERRORS as err:
                self._mark_failure(f"start_clean failed: {err}")
                raise
            if accepted:
                self._mark_success("start_clean accepted")
            return {"command": "start_clean", "accepted": accepted}
        raise ValueError(f"unknown command for litterrobot: {command.name!r}")

    async def health(self) -> AdapterHealth:
        status = self._status
        if status is HealthStatus.DEGRADED and self._failures >= ERROR_AFTER_FAILURES:
            status = HealthStatus.ERROR
        return AdapterHealth(
            status=status,
            detail=self._detail,
            last_success_utc=self._last_success,
            consecutive_failures=self._failures,
        )

    # ── extras used by the API layer ─────────────────────────────────────

    async def get_activity(self, limit: int = 50) -> list[dict[str, Any]]:
        """Activity history, newest first (network call to the cloud)."""
        robot = self._robot
        if robot is None:
            raise RuntimeError("litterrobot adapter is not connected")
        try:
            async with asyncio.timeout(REQUEST_TIMEOUT_S):
                activities = await robot.get_activity_history(limit=limit)
        except TRANSIENT_ERRORS as err:
            self._mark_failure(f"history fetch failed: {err}")
            raise
        self._mark_success("history fetched")
        result = []
        for a in activities:
            action = a.action
            if isinstance(action, LitterBoxStatus):
                label = action.text or action.value or action.name
            else:
                label = str(action)
            result.append({"timestamp_utc": a.timestamp.isoformat(), "action": label})
        return result

    # ── health bookkeeping ───────────────────────────────────────────────

    def _mark_success(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.OK, detail
        self._last_success = datetime.now(timezone.utc)
        self._failures = 0
        self._login_failures = 0

    def _mark_failure(self, detail: str) -> None:
        self._failures += 1
        self._status, self._detail = HealthStatus.DEGRADED, detail

    def _set_error(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.ERROR, detail
