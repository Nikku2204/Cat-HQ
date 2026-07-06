"""Petlibro adapter unit tests (docs/04-TESTING.md Phase 2 — test_petlibro_adapter.py).

Pure-logic tests: the adapter is constructed directly (the client constructor
only MD5s the password — no I/O) and every client method the code under test
would touch is replaced with an async fake. No network, no vendor cloud, no
hardware (hard rules 1+2).

Covered: `_compute_next_feed` schedule math (weekday roll, stringified
repeatDay, per-plan timezones, the DST spring-forward gap, malformed plans
never raise), `get_feed_log` day-bucket flattening + the flattened-limit
regression guard, and the health state machine (OK → DEGRADED → ERROR
promotion, device-offline override, `_note_cloud_success` freshness rules).

Documented spec deviations (suite stays green against ACTUAL behavior — see
the matching tests):
- docs/04 says a missing `recordTime` is "skipped": the adapter actually
  emits the entry with `timestamp_utc=None`; the RECORDER is what drops it.
- a colon-less malformed `executionTime` is filtered by the enable/":"
  pre-check and skipped SILENTLY; only colon-containing garbage reaches the
  logged-warning path docs/04 describes.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

import app.adapters.petlibro.adapter as pl_adapter
from app.adapters.base import HealthStatus
from app.adapters.petlibro.adapter import PetlibroAdapter
from app.adapters.petlibro.client import PetlibroAPIError

ADAPTER_LOGGER = "app.adapters.petlibro.adapter"
LA_TZ = "America/Los_Angeles"

# Frozen "now" for most schedule tests: Monday 2026-07-06 10:00 PDT.
NOW_MON = datetime(2026, 7, 6, 17, 0, tzinfo=timezone.utc)


# ── local helpers ────────────────────────────────────────────────────────


def freeze_now(monkeypatch: pytest.MonkeyPatch, instant: datetime) -> None:
    """Pin the adapter module's datetime.now() to `instant` (aware UTC).

    Subclassing keeps combine()/astimezone()/fromtimestamp()/comparisons
    working; the adapter only ever calls now() with an explicit tz."""

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # signature-compatible with datetime.now
            assert tz is not None, "adapter must ask for an aware 'now'"
            return instant.astimezone(tz)

    monkeypatch.setattr(pl_adapter, "datetime", FrozenDatetime)


def plan(**overrides: Any) -> dict[str, Any]:
    """One vendor feeding plan. repeatDay is a STRINGIFIED list of ISO
    weekdays (1=Mon..7=Sun) — that quirk is exactly what's under test."""
    base: dict[str, Any] = {
        "id": 1,
        "enable": True,
        "executionTime": "08:30",
        "timezone": LA_TZ,
        "repeatDay": "[1,2,3,4,5,6,7]",
        "grainNum": 2,
    }
    base.update(overrides)
    return base


def rec(
    ts: datetime | int | None,
    type_: str = "GRAIN_OUTPUT_SUCCESS",
    grains: Any = 2,
) -> dict[str, Any]:
    """One vendor work record; `ts` is a datetime (→ ms epoch), a raw int,
    or None (key omitted entirely, the shape docs/04 flags)."""
    r: dict[str, Any] = {"type": type_, "actualGrainNum": grains}
    if ts is not None:
        r["recordTime"] = ts if isinstance(ts, int) else int(ts.timestamp() * 1000)
    return r


def stub_work_records(adapter: PetlibroAdapter, buckets: list[dict]) -> list[dict]:
    """Replace the client call with an async fake; returns the captured
    call kwargs so tests can assert what the adapter forwarded."""
    calls: list[dict] = []

    async def fake_work_records(serial: str, *, days: int = 7, size: int = 50):
        calls.append({"serial": serial, "days": days, "size": size})
        return buckets

    adapter._client.work_records = fake_work_records  # type: ignore[method-assign]
    return calls


@pytest.fixture
def adapter() -> PetlibroAdapter:
    """Safe to construct: PetlibroClient.__init__ only MD5s the password."""
    return PetlibroAdapter(email="t@example.com", password="x", tz=LA_TZ)


# ── _compute_next_feed: schedule math ────────────────────────────────────


def test_next_feed_later_today(adapter, monkeypatch):
    """A plan still ahead of local now lands today; full result shape."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed([plan(executionTime="18:30", repeatDay="[1]")])
    # Monday 18:30 PDT == Tuesday 01:30 UTC
    assert result == {"time_utc": "2026-07-07T01:30:00+00:00", "portions": 2}


def test_next_feed_rolls_past_time_to_next_listed_day(adapter, monkeypatch):
    """08:30 already behind Monday-10:00 local now → tomorrow (all days listed)."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed([plan(executionTime="08:30")])
    assert result["time_utc"] == "2026-07-07T15:30:00+00:00"  # Tue 08:30 PDT


def test_next_feed_honors_repeat_days_across_the_roll(adapter, monkeypatch):
    """"[1,3,5]" (Mon/Wed/Fri): Monday's slot is past, Tuesday isn't listed,
    so the roll must land on Wednesday — not just "tomorrow"."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed(
        [plan(executionTime="08:30", repeatDay="[1,3,5]")]
    )
    assert result["time_utc"] == "2026-07-08T15:30:00+00:00"  # Wed 08:30 PDT


def test_next_feed_empty_repeat_day_means_every_day(adapter, monkeypatch):
    """"[]" is the vendor's "daily": json.loads gives [] and the fallback
    fills in all 7 ISO weekdays."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed([plan(executionTime="08:30", repeatDay="[]")])
    assert result["time_utc"] == "2026-07-07T15:30:00+00:00"  # Tue, the very next day


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param({"enable": False}, id="enable-false"),
        pytest.param({"enable": None}, id="enable-null"),
        pytest.param("drop-key", id="enable-missing"),
    ],
)
def test_next_feed_disabled_plan_skipped(adapter, monkeypatch, mutate):
    freeze_now(monkeypatch, NOW_MON)
    p = plan(executionTime="18:30")
    if mutate == "drop-key":
        del p["enable"]
    else:
        p.update(mutate)
    assert adapter._compute_next_feed([p]) is None


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"executionTime": "8:xx"}, id="non-numeric-minute"),
        pytest.param({"executionTime": "24:99"}, id="out-of-range-time"),
        pytest.param({"executionTime": ":"}, id="bare-colon"),
        pytest.param({"repeatDay": "1,3,5"}, id="unbracketed-repeatDay"),
        pytest.param({"timezone": "Not/AZone"}, id="unknown-timezone"),
    ],
)
def test_next_feed_malformed_plan_logged_and_skipped(
    adapter, monkeypatch, caplog, overrides
):
    """Garbage in any parsed field: warning logged, None returned, NEVER
    raises (dashboard sugar must not kill the poll)."""
    freeze_now(monkeypatch, NOW_MON)
    with caplog.at_level(logging.WARNING, logger=ADAPTER_LOGGER):
        result = adapter._compute_next_feed([plan(id=42, **overrides)])
    assert result is None
    assert "could not parse feeding plan 42" in caplog.text


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param({"executionTime": ""}, id="empty-string"),
        pytest.param({"executionTime": "0830"}, id="no-colon"),
        pytest.param("drop-key", id="key-missing"),
    ],
)
def test_next_feed_colonless_time_skipped_silently(adapter, monkeypatch, caplog, mutate):
    """SPEC MISMATCH (documented): docs/04 says malformed executionTime is
    "logged-and-skipped", but a value with no ":" is filtered by the same
    pre-check as `enable` — skipped with NO warning. Only colon-containing
    garbage reaches the logged path (test above)."""
    freeze_now(monkeypatch, NOW_MON)
    p = plan()
    if mutate == "drop-key":
        del p["executionTime"]
    else:
        p.update(mutate)
    with caplog.at_level(logging.WARNING, logger=ADAPTER_LOGGER):
        assert adapter._compute_next_feed([p]) is None
    assert "could not parse feeding plan" not in caplog.text


def test_next_feed_broken_plan_does_not_mask_good_one(adapter, monkeypatch, caplog):
    """Per-plan try/except: one rotten plan logs and the rest still compute."""
    freeze_now(monkeypatch, NOW_MON)
    plans = [
        plan(id=7, executionTime="9:zz"),
        plan(id=8, executionTime="18:30", grainNum=4),
    ]
    with caplog.at_level(logging.WARNING, logger=ADAPTER_LOGGER):
        result = adapter._compute_next_feed(plans)
    assert result == {"time_utc": "2026-07-07T01:30:00+00:00", "portions": 4}
    assert "could not parse feeding plan 7" in caplog.text


def test_next_feed_plan_timezone_beats_owner_tz(adapter, monkeypatch):
    """Each plan carries its own IANA tz. At NOW_MON it is already Tuesday
    02:00 in Tokyo, so a 10:00 JST plan fires Tue 01:00 UTC — an LA reading
    of the same plan would say Tue 17:00 UTC, so this discriminates."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed(
        [plan(executionTime="10:00", timezone="Asia/Tokyo", repeatDay="[]")]
    )
    assert result["time_utc"] == "2026-07-07T01:00:00+00:00"


def test_next_feed_missing_timezone_falls_back_to_owner_tz(adapter, monkeypatch):
    """`plan["timezone"] or self._tz`: null tz → the adapter's owner tz."""
    freeze_now(monkeypatch, NOW_MON)
    result = adapter._compute_next_feed(
        [plan(executionTime="18:30", timezone=None)]
    )
    assert result["time_utc"] == "2026-07-07T01:30:00+00:00"  # LA, not UTC


def test_next_feed_dst_spring_forward_gap(adapter, monkeypatch):
    """America/Los_Angeles springs forward 2026-03-08 02:00→03:00. A daily
    02:30 plan next fires inside the gap. Documented actual behavior: PEP 495
    fold=0 resolves a nonexistent local time with the PRE-transition offset
    (PST, -08:00), so 02:30 maps to 10:30 UTC == 03:30 PDT wall clock — 30
    minutes after the jump. Must not crash; must return an aware-UTC ISO."""
    # Sat 2026-03-07 20:00 PST == Sun 04:00 UTC
    freeze_now(monkeypatch, datetime(2026, 3, 8, 4, 0, tzinfo=timezone.utc))
    result = adapter._compute_next_feed([plan(executionTime="02:30", repeatDay="[]")])
    assert result["time_utc"] == "2026-03-08T10:30:00+00:00"
    parsed = datetime.fromisoformat(result["time_utc"])
    assert parsed.utcoffset() == timedelta(0)  # aware, UTC


def test_next_feed_earliest_upcoming_plan_wins(adapter, monkeypatch):
    """Three plans, three different next-fire days — the soonest UTC instant
    wins and brings ITS portions along."""
    freeze_now(monkeypatch, NOW_MON)
    plans = [
        plan(id=1, executionTime="18:30", grainNum=2, repeatDay="[]"),  # today 18:30
        plan(id=2, executionTime="12:00", grainNum=5, repeatDay="[]"),  # today 12:00 ←
        plan(id=3, executionTime="08:30", grainNum=9, repeatDay="[]"),  # tomorrow
    ]
    result = adapter._compute_next_feed(plans)
    assert result == {"time_utc": "2026-07-06T19:00:00+00:00", "portions": 5}


@pytest.mark.parametrize(
    ("grain", "expected"),
    [
        pytest.param(None, 0, id="null"),
        pytest.param("drop-key", 0, id="missing"),
        pytest.param(4, 4, id="int-passthrough"),
    ],
)
def test_next_feed_grain_num_fallback(adapter, monkeypatch, grain, expected):
    """`grainNum or 0`: null/missing portions read as 0, never crash."""
    freeze_now(monkeypatch, NOW_MON)
    p = plan(executionTime="18:30")
    if grain == "drop-key":
        del p["grainNum"]
    else:
        p["grainNum"] = grain
    assert adapter._compute_next_feed([p])["portions"] == expected


def test_next_feed_no_plans_is_none(adapter, monkeypatch):
    freeze_now(monkeypatch, NOW_MON)
    assert adapter._compute_next_feed([]) is None


# ── get_feed_log: day-bucket flattening ──────────────────────────────────

FEED_T0 = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


async def test_feed_log_requires_discovery(adapter):
    """No serial yet → fail loudly BEFORE any cloud call."""
    calls = stub_work_records(adapter, [])
    with pytest.raises(RuntimeError, match="not connected"):
        await adapter.get_feed_log()
    assert calls == []


async def test_feed_log_flattens_filters_and_recaps_limit(adapter):
    """The vendor `size` caps records PER DAY-BUCKET, not the total (source
    comment) — so with every bucket within size, the flattened total can
    still exceed `limit` and the adapter must re-cap it itself. Also:
    non-GRAIN_OUTPUT_SUCCESS filtered, workRecords=None/missing buckets
    survive, order preserved, ms-epoch → aware-UTC ISO."""
    adapter._serial = "SN1"
    t = [FEED_T0 + timedelta(minutes=i) for i in range(6)]
    buckets = [
        {"workRecords": [
            rec(t[0]),
            rec(t[1], type_="GRAIN_OUTPUT_FAIL"),   # filtered out
            rec(t[2], grains=3),
        ]},
        {"workRecords": None},                       # vendor null — survives
        {},                                          # key missing — survives
        {"workRecords": [rec(t[3]), rec(t[4]), rec(t[5])]},
    ]
    calls = stub_work_records(adapter, buckets)

    events = await adapter.get_feed_log(days=3, limit=4)

    # 5 successes flattened across buckets, capped at limit=4, order kept
    assert [e["timestamp_utc"] for e in events] == [
        t[0].isoformat(), t[2].isoformat(), t[3].isoformat(), t[4].isoformat()
    ]
    assert all(e["type"] == "GRAIN_OUTPUT_SUCCESS" for e in events)
    assert events[1]["portions"] == 3
    assert set(events[0]) == {"timestamp_utc", "portions", "type"}
    # limit forwarded as the per-bucket size, days passed through
    assert calls == [{"serial": "SN1", "days": 3, "size": 4}]
    # success is a connectivity proof only — status untouched, clock bumped
    assert adapter._last_cloud_success is not None
    assert adapter._status is HealthStatus.UNCONFIGURED


async def test_feed_log_missing_record_time_emits_none_timestamp(adapter):
    """SPEC MISMATCH (documented): docs/04 says "missing recordTime skipped"
    but the adapter emits the row with timestamp_utc=None (`if ts else None`
    — a 0/epoch recordTime is falsy and also maps to None); the recorder is
    the layer that actually drops timestamp-less rows."""
    adapter._serial = "SN1"
    stub_work_records(adapter, [
        {"workRecords": [rec(None), rec(0), rec(FEED_T0)]},
    ])
    events = await adapter.get_feed_log()
    assert [e["timestamp_utc"] for e in events] == [None, None, FEED_T0.isoformat()]


async def test_feed_log_null_grain_num_is_zero_portions(adapter):
    adapter._serial = "SN1"
    stub_work_records(adapter, [{"workRecords": [rec(FEED_T0, grains=None)]}])
    events = await adapter.get_feed_log()
    assert events[0]["portions"] == 0


async def test_feed_log_transient_failure_marks_degraded_and_reraises(adapter):
    """A failed history fetch counts against poll health (it IS a cloud
    failure) and surfaces to the caller."""
    adapter._serial = "SN1"
    adapter._mark_poll_success("polled")

    async def fail(serial: str, *, days: int = 7, size: int = 50):
        raise PetlibroAPIError(None, "boom")

    adapter._client.work_records = fail  # type: ignore[method-assign]
    with pytest.raises(PetlibroAPIError):
        await adapter.get_feed_log()
    h = await adapter.health()
    assert h.status is HealthStatus.DEGRADED
    assert h.consecutive_failures == 1
    assert h.detail.startswith("feed log fetch failed")


# ── health state machine ─────────────────────────────────────────────────


async def test_health_initial_unconfigured(adapter):
    h = await adapter.health()
    assert h.status is HealthStatus.UNCONFIGURED
    assert h.detail == "not started"
    assert h.last_success_utc is None
    assert h.consecutive_failures == 0


async def test_health_ok_after_poll_success(adapter):
    adapter._mark_poll_success("connected")
    h = await adapter.health()
    assert h.status is HealthStatus.OK
    assert h.detail == "connected"
    assert h.last_success_utc is not None
    assert h.consecutive_failures == 0


@pytest.mark.parametrize(
    ("n_failures", "expected"),
    [
        pytest.param(1, HealthStatus.DEGRADED, id="1-degraded"),
        pytest.param(4, HealthStatus.DEGRADED, id="4-still-degraded"),
        pytest.param(5, HealthStatus.ERROR, id="5-promotes-to-error"),
        pytest.param(6, HealthStatus.ERROR, id="6-stays-error"),
    ],
)
async def test_health_failure_escalation(adapter, n_failures, expected):
    """DEGRADED from the first failure; health() promotes the BADGE to ERROR
    at ERROR_AFTER_FAILURES — the stored status stays DEGRADED (view-level
    promotion, so one good poll fully recovers)."""
    adapter._mark_poll_success("connected")
    for i in range(n_failures):
        adapter._mark_failure(f"poll failed: boom {i}")
    h = await adapter.health()
    assert h.status is expected
    assert h.consecutive_failures == n_failures
    assert "boom" in h.detail
    assert adapter._status is HealthStatus.DEGRADED  # never latched to ERROR


async def test_health_offline_device_degrades_ok_status(adapter):
    """Cloud fine but the feeder itself is dark → DEGRADED with the specific
    power/wifi hint; failure counter untouched, stored status still OK."""
    adapter._mark_poll_success("polled")
    adapter._device_online = False
    h = await adapter.health()
    assert h.status is HealthStatus.DEGRADED
    assert h.detail == "feeder reports offline (check power/wifi)"
    assert h.consecutive_failures == 0
    assert adapter._status is HealthStatus.OK  # view-level override only


async def test_health_offline_does_not_mask_failure_detail(adapter):
    """The offline override applies to OK only — a real poll failure keeps
    its own (more actionable) detail even if the device also looks offline."""
    adapter._mark_poll_success("polled")
    adapter._mark_failure("poll failed: timeout")
    adapter._device_online = False
    h = await adapter.health()
    assert h.status is HealthStatus.DEGRADED
    assert h.detail == "poll failed: timeout"


async def test_note_cloud_success_keeps_stale_health(adapter, monkeypatch):
    """A successful manual feed mid-outage proves connectivity but must NOT
    fake state freshness: status/detail/counters untouched, only
    last_success_utc advances."""
    t1 = datetime(2026, 7, 6, 0, 0, tzinfo=timezone.utc)
    t2 = t1 + timedelta(minutes=5)
    freeze_now(monkeypatch, t1)
    adapter._mark_poll_success("polled")
    adapter._mark_failure("poll failed: outage")
    adapter._mark_failure("poll failed: outage")
    freeze_now(monkeypatch, t2)
    adapter._note_cloud_success()
    h = await adapter.health()
    assert h.status is HealthStatus.DEGRADED
    assert h.consecutive_failures == 2
    assert h.detail == "poll failed: outage"
    assert h.last_success_utc == t2            # connectivity clock advances...
    assert adapter._last_state_refresh == t1   # ...state freshness does not


async def test_poll_success_resets_all_counters(adapter):
    """One good state poll clears both failure counters and the badge —
    including recovery from the ERROR-promoted view."""
    adapter._login_failures = 3
    for _ in range(5):
        adapter._mark_failure("poll failed: down")
    assert (await adapter.health()).status is HealthStatus.ERROR
    adapter._mark_poll_success("polled")
    h = await adapter.health()
    assert h.status is HealthStatus.OK
    assert h.consecutive_failures == 0
    assert adapter._login_failures == 0


async def test_on_refresh_hook_failure_is_swallowed(adapter):
    """The M4 hub notifier must never break bookkeeping (source contract:
    'notification must never break polling')."""
    calls: list[int] = []

    def bad_hook() -> None:
        calls.append(1)
        raise RuntimeError("hub down")

    adapter.on_refresh = bad_hook
    adapter._mark_failure("poll failed: x")   # must not raise
    adapter._mark_poll_success("recovered")   # must not raise
    assert len(calls) == 2
    assert (await adapter.health()).status is HealthStatus.OK


async def test_get_state_fails_loud_until_first_poll(adapter):
    """Fail-loud contract: no successful poll yet → RuntimeError, never stale
    or fabricated data; after one, fetched_at_utc is the POLL time."""
    assert adapter.connected is False
    with pytest.raises(RuntimeError, match="not connected"):
        await adapter.get_state()
    # simulate exactly the bookkeeping one good poll leaves behind
    t1 = datetime(2026, 7, 6, 0, 0, tzinfo=timezone.utc)
    adapter._serial = "SN1"
    adapter._live = {"online": True}
    adapter._last_state_refresh = t1
    assert adapter.connected is True
    state = await adapter.get_state()
    assert state.fetched_at_utc == t1                 # never the request time
    assert state.attributes == {"online": True}
    assert state.attributes is not adapter._live      # defensive copy
