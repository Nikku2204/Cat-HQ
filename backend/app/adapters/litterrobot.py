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
  M3/M4 when the app grows its own WebSocket broadcast channel.

Error policy (hardened after adversarial review, 2026-07-05):
- pylitterbot leaks raw botocore exceptions on Cognito paths: BotoCoreError
  network failures at login, and raw botocore ClientError from the automatic
  token refresh inside ANY request once the refresh token dies. Both are
  handled here explicitly.
- Account.connect() wraps EVERY Cognito ClientError (including throttles and
  Cognito 5xx) into LitterRobotLoginException — we peek at the exception
  chain to distinguish genuine credential rejections from vendor blips.
- The poll loop NEVER stops permanently. Credential-looking failures retry
  with escalating backoff (60s → 30min cap, ERROR badge after 2 strikes) so
  a transient misclassification can't require a manual restart, while true
  bad creds stay loud without hammering Cognito. Unexpected errors tear the
  account down so the next cycle does a full re-login with credentials —
  that is the only reliable recovery from a dead refresh token.
- start() NEVER raises: a Whisker outage at boot must not take down /health
  and the other adapters.
"""
from __future__ import annotations

import asyncio
import logging
import random
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any

import aiohttp
from botocore.exceptions import BotoCoreError
from botocore.exceptions import ClientError as CognitoClientError
from pylitterbot import Account, LitterRobot4
from pylitterbot.enums import LitterBoxStatus
from pylitterbot.exceptions import LitterRobotException, LitterRobotLoginException

from .base import AdapterHealth, Command, DeviceAdapter, DeviceState, HealthStatus

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 60          # CLAUDE.md cadence: ~60s with jitter
MAX_BACKOFF_S = 600           # transient-failure cap; never tight-loop Whisker
LOGIN_BACKOFF_CAP_S = 1800    # credential-failure retry cap (30 min)
REQUEST_TIMEOUT_S = 45        # cap a single refresh so the loop stays alive
ERROR_AFTER_FAILURES = 5      # consecutive failures before DEGRADED→ERROR

# Errors that mean "cloud/transient" — backoff and retry. BotoCoreError covers
# the Cognito network-failure family (EndpointConnectionError, timeouts, SSL).
TRANSIENT_ERRORS = (
    LitterRobotException,
    aiohttp.ClientError,
    TimeoutError,
    BotoCoreError,
)

# Cognito error codes that genuinely mean "the credentials are wrong".
# Everything else on a ClientError (TooManyRequestsException,
# InternalErrorException, ...) is a vendor-side blip and must be retried.
CREDENTIAL_ERROR_CODES = {
    "NotAuthorizedException",
    "UserNotFoundException",
    "UserNotConfirmedException",
    "PasswordResetRequiredException",
}


def _cognito_code(err: CognitoClientError) -> str | None:
    try:
        return err.response.get("Error", {}).get("Code")
    except AttributeError:
        return None


def _is_credential_failure(err: BaseException) -> bool:
    """True only when the error clearly means bad credentials."""
    if isinstance(err, CognitoClientError):
        return _cognito_code(err) in CREDENTIAL_ERROR_CODES
    if isinstance(err, (LitterRobotLoginException, KeyError)):
        # connect() wraps every Cognito ClientError in LitterRobotLoginException
        # (and its own error handler can KeyError on some ClientError shapes).
        # Peek at the chained exception so throttles/5xx don't read as creds.
        chained = err.__cause__ or err.__context__
        if isinstance(chained, CognitoClientError):
            return _cognito_code(chained) in CREDENTIAL_ERROR_CODES
        # 401 paths and missing-credential paths carry no Cognito context.
        return isinstance(err, LitterRobotLoginException)
    return False


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
        self._last_state_refresh: datetime | None = None  # last good state poll
        self._last_cloud_success: datetime | None = None  # any successful call
        self._failures = 0
        self._login_failures = 0

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Connect and start polling. NEVER raises — every failure lands in
        health() and the poll loop keeps retrying (with escalating backoff
        for credential-looking failures)."""
        self._status, self._detail = HealthStatus.DEGRADED, "connecting"
        try:
            await self._connect()
            self._mark_poll_success("connected")
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 — startup must survive anything
            if _is_credential_failure(err):
                self._login_failures = 1
                self._set_error(
                    f"login rejected: {err} — check WHISKER_EMAIL/WHISKER_PASSWORD"
                )
                logger.error("Whisker login rejected; will retry slowly: %s", err)
            else:
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
            async with asyncio.timeout(REQUEST_TIMEOUT_S):
                await account.connect(
                    username=self._email,
                    password=self._password,
                    load_robots=True,
                    subscribe_for_updates=False,  # M1: poll-only
                )
            # ignore_removed=True keeps only onboarded robots — never bind to
            # an RMA'd/de-onboarded unit that still lingers on the account.
            robots = account.get_robots(LitterRobot4, ignore_removed=True)
            if not robots:
                robots = account.get_robots(LitterRobot4)
                if robots:
                    logger.warning(
                        "only non-onboarded LR4s on account; using %s",
                        robots[0].serial,
                    )
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
        self._last_state_refresh = datetime.now(timezone.utc)

    async def _poll_loop(self) -> None:
        delay: float = POLL_INTERVAL_S
        while True:
            await asyncio.sleep(delay * random.uniform(0.9, 1.1))
            try:
                if self._robot is None:
                    await self._connect()
                else:
                    async with asyncio.timeout(REQUEST_TIMEOUT_S):
                        await self._robot.refresh()
                self._mark_poll_success("polled")
                delay = POLL_INTERVAL_S
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — classified below
                delay = await self._handle_poll_error(err, delay)

    async def _handle_poll_error(self, err: Exception, delay: float) -> float:
        """Classify a poll failure, update health, decide the next delay.
        The loop never stops: worst case is a slow retry with a loud badge."""
        if _is_credential_failure(err):
            self._login_failures += 1
            await self._teardown_account()  # full re-login next cycle
            detail = (
                f"login rejected ({self._login_failures}x): {err} — "
                "check WHISKER_EMAIL/WHISKER_PASSWORD (or Whisker outage)"
            )
            if self._login_failures >= 2:
                self._set_error(detail)
            else:
                self._mark_failure(detail)
            next_delay = min(
                POLL_INTERVAL_S * 2 ** self._login_failures, LOGIN_BACKOFF_CAP_S
            )
            logger.error(
                "Whisker login failure #%d, next attempt ~%ds: %s",
                self._login_failures, int(next_delay), err,
            )
            return next_delay
        if isinstance(err, TRANSIENT_ERRORS) or (
            isinstance(err, (CognitoClientError, KeyError))
        ):
            # Includes Cognito throttles/5xx and raw ClientError from the
            # automatic token refresh — teardown so the next cycle re-logins
            # with credentials (recovers a dead refresh token).
            if isinstance(err, (CognitoClientError, KeyError)):
                await self._teardown_account()
            self._mark_failure(f"poll failed: {err}")
            next_delay = min(delay * 2, MAX_BACKOFF_S)
            logger.warning(
                "Whisker poll failed (%d in a row, next try ~%ds): %s",
                self._failures, int(next_delay), err,
            )
            return next_delay
        # Truly unexpected: loud, tear down, retry slowly — self-heals if the
        # cause was a one-off, stays visibly broken if not.
        self._set_error(f"unexpected error: {err!r}")
        await self._teardown_account()
        logger.exception("unexpected error in litterrobot poll loop")
        return MAX_BACKOFF_S

    # ── DeviceAdapter interface ──────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._robot is not None

    async def get_state(self) -> DeviceState:
        """Read current state off the poll-refreshed Robot object (no I/O).
        fetched_at_utc is the time of the last successful STATE refresh —
        never fabricated from the request time."""
        robot = self._robot
        if robot is None or self._last_state_refresh is None:
            raise RuntimeError("litterrobot adapter is not connected")
        return DeviceState(
            device_id=self.device_id,
            device_type=self.device_type,
            fetched_at_utc=self._last_state_refresh,
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
            # command; False = cloud rejected it (the library logs why).
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    accepted = await robot.start_cleaning()
            except (*TRANSIENT_ERRORS, CognitoClientError, KeyError) as err:
                self._mark_failure(f"start_clean failed: {err}")
                raise
            if accepted:
                # Proves cloud connectivity but is NOT a state refresh —
                # don't flip poll health or reset failure counters.
                self._note_cloud_success()
            return {"command": "start_clean", "accepted": accepted}
        raise ValueError(f"unknown command for litterrobot: {command.name!r}")

    async def health(self) -> AdapterHealth:
        status = self._status
        if status is HealthStatus.DEGRADED and self._failures >= ERROR_AFTER_FAILURES:
            status = HealthStatus.ERROR
        return AdapterHealth(
            status=status,
            detail=self._detail,
            last_success_utc=self._last_cloud_success,
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
        except (*TRANSIENT_ERRORS, CognitoClientError, KeyError) as err:
            self._mark_failure(f"history fetch failed: {err}")
            raise
        self._note_cloud_success()  # not a state refresh — see execute()
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

    def _mark_poll_success(self, detail: str) -> None:
        """A successful STATE refresh — the only thing that flips health OK."""
        self._status, self._detail = HealthStatus.OK, detail
        now = datetime.now(timezone.utc)
        self._last_state_refresh = now
        self._last_cloud_success = now
        self._failures = 0
        self._login_failures = 0

    def _note_cloud_success(self) -> None:
        """A successful command/history call: proves connectivity, does NOT
        vouch for state freshness — health status/counters untouched."""
        self._last_cloud_success = datetime.now(timezone.utc)

    def _mark_failure(self, detail: str) -> None:
        self._failures += 1
        self._status, self._detail = HealthStatus.DEGRADED, detail

    def _set_error(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.ERROR, detail
