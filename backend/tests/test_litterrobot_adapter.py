"""Tests for backend/app/adapters/litterrobot.py (docs/04 Phase 2).

Covers: the `_is_credential_failure` classification matrix (raw Cognito
ClientErrors, chained LitterRobotLoginException/KeyError, bare fallbacks),
`_handle_poll_error` backoff arithmetic + health badges + account teardown,
and `get_state` attribute mapping off a stub Robot.

Pure-logic tests — the constructor does no I/O and every case drives adapter
internals directly; no network, no vendor cloud, no hardware (docs/04 rules).

Login-failure backoff contract (docs/04 was amended to match the code): the
base is POLL_INTERVAL_S = 300 (the M4 5-min reconcile — 60s was only the M1
poll rate), so the sequence is min(300 * 2**strikes, 1800) = 600 → 1200 →
1800 (cap). These tests pin that arithmetic.
"""
from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Callable

import pytest
from botocore.exceptions import ClientError as CognitoClientError
from pylitterbot.exceptions import LitterRobotException, LitterRobotLoginException

from app.adapters.base import HealthStatus
from app.adapters.litterrobot import (
    LOGIN_BACKOFF_CAP_S,
    MAX_BACKOFF_S,
    POLL_INTERVAL_S,
    LitterRobotAdapter,
    _is_credential_failure,
)

# ── local helpers ────────────────────────────────────────────────────────


def _adapter() -> LitterRobotAdapter:
    """Constructor does no I/O; start()/_connect() are never called here."""
    return LitterRobotAdapter(email="e@example.com", password="x")


def _client_error(code: str) -> CognitoClientError:
    """A botocore ClientError shaped like Cognito's error responses."""
    return CognitoClientError(
        {"Error": {"Code": code, "Message": "cognito says no"}}, "InitiateAuth"
    )


def _chained(outer: BaseException, cause: BaseException) -> BaseException:
    """Return `outer` with a REAL __cause__ (raise-from, not attribute
    poking) — exactly what pylitterbot's connect() error handler produces."""
    try:
        raise outer from cause
    except BaseException as caught:  # noqa: BLE001 — re-catching what we raised
        return caught


class StubAccount:
    """Stands in for pylitterbot.Account so _teardown_account has a real
    async disconnect() to call (and we can assert it was called)."""

    def __init__(self) -> None:
        self.disconnected = False

    async def disconnect(self) -> None:
        self.disconnected = True


def _stub_robot(**overrides: Any) -> SimpleNamespace:
    """Every attribute get_state() reads, with realistic values. Enum-like
    fields default to SimpleNamespace(value=...) — pylitterbot enums."""
    base: dict[str, Any] = dict(
        name="Pinsu's Robot",
        serial="LR4C000000",
        model="Litter-Robot 4",
        is_online=True,
        is_on=True,
        power_type="AC",
        status_code="RDY",
        status_text="Ready",
        is_sleeping=False,
        sleep_mode_enabled=True,
        waste_drawer_level=42.5,
        is_waste_drawer_full=False,
        litter_level=61.0,
        litter_level_state=SimpleNamespace(value="optimal"),
        cycle_count=17,
        cycle_capacity=58,
        cycles_after_drawer_full=0,
        scoops_saved_count=812,
        night_light_mode=SimpleNamespace(value="auto"),
        panel_lock_enabled=False,
        pet_weight=9.8,
        last_seen=datetime(2026, 7, 5, 8, 30, 0, tzinfo=timezone.utc),
        firmware="ESP: 1.1.50 / PIC: 10512.2560.2.53 / TOF: 4.0.65.4",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# ── _is_credential_failure classification matrix ─────────────────────────


@pytest.mark.parametrize(
    ("make_err", "expected"),
    [
        # Raw Cognito ClientError: only CREDENTIAL_ERROR_CODES mean bad creds.
        (lambda: _client_error("NotAuthorizedException"), True),
        (lambda: _client_error("UserNotFoundException"), True),
        (lambda: _client_error("TooManyRequestsException"), False),
        # connect() wraps every Cognito ClientError in LitterRobotLoginException
        # — the chain peek must keep throttles from reading as bad creds.
        (
            lambda: _chained(
                LitterRobotLoginException("login failed"),
                _client_error("TooManyRequestsException"),
            ),
            False,
        ),
        (
            lambda: _chained(
                LitterRobotLoginException("login failed"),
                _client_error("NotAuthorizedException"),
            ),
            True,
        ),
        # Bare LoginException: 401 / missing-credential paths, no Cognito
        # context — treated as a genuine credential failure.
        (lambda: LitterRobotLoginException("401 from /login"), True),
        # pylitterbot's error handler can KeyError on odd ClientError shapes;
        # classification follows the chained Cognito code.
        (
            lambda: _chained(
                KeyError("AuthenticationResult"),
                _client_error("NotAuthorizedException"),
            ),
            True,
        ),
        (
            lambda: _chained(
                KeyError("AuthenticationResult"),
                _client_error("TooManyRequestsException"),
            ),
            False,
        ),
        # Bare KeyError (no Cognito context) is NOT a credential failure.
        (lambda: KeyError("AuthenticationResult"), False),
        # Anything else is never a credential failure.
        (lambda: ValueError("nope"), False),
    ],
    ids=[
        "clienterror-notauthorized",
        "clienterror-usernotfound",
        "clienterror-throttle",
        "loginexc-from-throttle",
        "loginexc-from-notauthorized",
        "loginexc-bare",
        "keyerror-from-notauthorized",
        "keyerror-from-throttle",
        "keyerror-bare",
        "plain-valueerror",
    ],
)
def test_is_credential_failure(
    make_err: Callable[[], BaseException], expected: bool
) -> None:
    assert _is_credential_failure(make_err()) is expected


# ── _handle_poll_error: transient backoff ────────────────────────────────


@pytest.mark.parametrize(
    ("delay_in", "expected"),
    [(300, 600), (600, 600)],  # doubles, then holds at MAX_BACKOFF_S
    ids=["doubles-300-to-600", "capped-at-600"],
)
async def test_transient_error_doubles_delay_and_degrades(
    delay_in: float, expected: float
) -> None:
    adapter = _adapter()
    adapter._account = None  # teardown is a no-op (transient path skips it anyway)

    next_delay = await adapter._handle_poll_error(LitterRobotException("x"), delay_in)

    assert next_delay == expected
    assert adapter._failures == 1  # counter increments
    health = await adapter.health()
    assert health.status is HealthStatus.DEGRADED
    assert "poll failed" in health.detail
    assert health.consecutive_failures == 1


async def test_transient_error_does_not_tear_down_session() -> None:
    """A cloud blip must not drop the websocket subscription / session —
    only Cognito/KeyError and unexpected paths tear down."""
    adapter = _adapter()
    account, robot = StubAccount(), _stub_robot()
    adapter._account, adapter._robot = account, robot

    await adapter._handle_poll_error(LitterRobotException("blip"), 300)

    assert account.disconnected is False
    assert adapter._robot is robot
    assert adapter._account is account


async def test_transient_failures_reach_error_badge_only_at_threshold() -> None:
    """DEGRADED holds until ERROR_AFTER_FAILURES (5) consecutive failures —
    contrast with login strikes, which go ERROR at 2."""
    adapter = _adapter()
    adapter._account = None
    delay: float = POLL_INTERVAL_S
    for _ in range(4):
        delay = await adapter._handle_poll_error(LitterRobotException("x"), delay)
        assert (await adapter.health()).status is HealthStatus.DEGRADED
    await adapter._handle_poll_error(LitterRobotException("x"), delay)
    assert adapter._failures == 5
    assert (await adapter.health()).status is HealthStatus.ERROR


# ── _handle_poll_error: login-failure escalation ─────────────────────────


async def test_login_failure_escalation_badges_backoff_and_teardown() -> None:
    """min(POLL_INTERVAL_S * 2**strikes, LOGIN_BACKOFF_CAP_S) = 600 → 1200 →
    1800 → 1800, per the amended docs/04 bullet (see module docstring).
    ERROR badge only from the 2nd strike."""
    adapter = _adapter()
    account = StubAccount()
    adapter._account, adapter._robot = account, _stub_robot()
    err = LitterRobotLoginException("bad password")

    # strike 1: DEGRADED (benefit of the doubt), account torn down for a
    # full credentialed re-login next cycle.
    assert await adapter._handle_poll_error(err, POLL_INTERVAL_S) == 600
    assert adapter._login_failures == 1
    assert account.disconnected is True
    assert adapter._account is None and adapter._robot is None
    health = await adapter.health()
    assert health.status is HealthStatus.DEGRADED
    assert "login rejected (1x)" in health.detail
    assert "WHISKER_EMAIL" in health.detail  # actionable detail for the owner

    # strike 2: ERROR badge (>=2 strikes rule), 1200s.
    assert await adapter._handle_poll_error(err, 600) == 1200
    assert (await adapter.health()).status is HealthStatus.ERROR

    # strike 3 hits the 30-min cap; strike 4 stays there.
    assert await adapter._handle_poll_error(err, 1200) == LOGIN_BACKOFF_CAP_S == 1800
    assert await adapter._handle_poll_error(err, 1800) == 1800
    assert adapter._login_failures == 4
    assert "login rejected (4x)" in (await adapter.health()).detail


# ── _handle_poll_error: Cognito blips / dead refresh token ───────────────


@pytest.mark.parametrize(
    "make_err",
    [
        lambda: _client_error("InternalErrorException"),  # Cognito 5xx
        lambda: KeyError("AuthenticationResult"),  # odd ClientError shape
    ],
    ids=["raw-cognito-5xx", "bare-keyerror"],
)
async def test_cognito_blip_tears_down_with_transient_backoff(
    make_err: Callable[[], BaseException],
) -> None:
    """Raw ClientError/KeyError from the automatic token refresh: teardown
    (so the next cycle re-logins with credentials) + transient doubling,
    NOT a login strike."""
    adapter = _adapter()
    account = StubAccount()
    adapter._account, adapter._robot = account, _stub_robot()

    next_delay = await adapter._handle_poll_error(make_err(), 300)

    assert next_delay == 600  # transient-style doubling
    assert account.disconnected is True
    assert adapter._robot is None and adapter._account is None
    assert adapter._login_failures == 0  # not misread as bad creds
    assert (await adapter.health()).status is HealthStatus.DEGRADED


# ── _handle_poll_error: unexpected errors ────────────────────────────────


async def test_unexpected_error_goes_error_teardown_slow_retry() -> None:
    adapter = _adapter()
    account = StubAccount()
    adapter._account, adapter._robot = account, _stub_robot()

    next_delay = await adapter._handle_poll_error(ValueError("wat"), 300)

    assert next_delay == MAX_BACKOFF_S == 600
    assert account.disconnected is True
    assert adapter._robot is None and adapter._account is None
    health = await adapter.health()
    assert health.status is HealthStatus.ERROR
    assert "unexpected" in health.detail


# ── get_state mapping ────────────────────────────────────────────────────


async def test_get_state_maps_every_attribute() -> None:
    """Full-dict equality: catches renamed/missing/extra keys. Enum-like
    fields come through as .value; fetched_at_utc is the last successful
    state refresh, never fabricated from the request time."""
    adapter = _adapter()
    refreshed = datetime(2026, 7, 5, 9, 0, 0, tzinfo=timezone.utc)
    adapter._robot = _stub_robot()
    adapter._last_state_refresh = refreshed

    state = await adapter.get_state()

    assert state.device_id == "litterrobot"
    assert state.device_type == "litterrobot"
    assert state.fetched_at_utc == refreshed
    assert state.attributes == {
        "name": "Pinsu's Robot",
        "serial": "LR4C000000",
        "model": "Litter-Robot 4",
        "is_online": True,
        "is_on": True,
        "power_type": "AC",
        "status_code": "RDY",
        "status_text": "Ready",
        "is_sleeping": False,
        "sleep_mode_enabled": True,
        "waste_drawer_level_pct": 42.5,
        "is_waste_drawer_full": False,
        "litter_level_pct": 61.0,
        "litter_level_state": "optimal",  # enum → .value
        "cycle_count": 17,
        "cycle_capacity": 58,
        "cycles_after_drawer_full": 0,
        "scoops_saved_count": 812,
        "night_light_mode": "auto",  # enum → .value
        "panel_lock_enabled": False,
        "pet_weight_lbs": 9.8,
        "last_seen_utc": "2026-07-05T08:30:00+00:00",  # datetime → isoformat
        "firmware": "ESP: 1.1.50 / PIC: 10512.2560.2.53 / TOF: 4.0.65.4",
    }


async def test_get_state_none_enums_and_none_last_seen() -> None:
    """Optional/enum fields pass None straight through — no .value crash."""
    adapter = _adapter()
    adapter._robot = _stub_robot(
        litter_level_state=None, night_light_mode=None, last_seen=None
    )
    adapter._last_state_refresh = datetime.now(timezone.utc)

    attrs = (await adapter.get_state()).attributes

    assert attrs["litter_level_state"] is None
    assert attrs["night_light_mode"] is None
    assert attrs["last_seen_utc"] is None


@pytest.mark.parametrize(
    ("have_robot", "have_refresh"),
    [(False, True), (True, False), (False, False)],
    ids=["no-robot", "no-refresh-timestamp", "neither"],
)
async def test_get_state_raises_when_not_connected(
    have_robot: bool, have_refresh: bool
) -> None:
    """RuntimeError both when _robot is None AND when a robot exists but no
    state refresh ever succeeded (fetched_at must never be fabricated)."""
    adapter = _adapter()
    adapter._robot = _stub_robot() if have_robot else None
    adapter._last_state_refresh = (
        datetime.now(timezone.utc) if have_refresh else None
    )
    with pytest.raises(RuntimeError, match="not connected"):
        await adapter.get_state()
