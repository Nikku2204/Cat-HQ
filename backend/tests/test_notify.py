"""Notifier (WhatsApp alerts via CallMeBot) — rules, dedupe, cold-start.

HARD RULES: no network anywhere — the transport is an injected spy; the
conftest env-blanking means the real lifespan never constructs a live
sender in any test. Time is injected so cooldowns and the evening digest
are deterministic.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.notify import Notifier
from conftest import FakeAdapter, seed_events


class SpySender:
    def __init__(self, ok: bool = True):
        self.ok = ok
        self.sent: list[str] = []

    async def __call__(self, text: str) -> bool:
        self.sent.append(text)
        return self.ok


class Clock:
    """Injectable monotonic + wall clock."""

    def __init__(self, now: datetime):
        self.mono = 1000.0
        self.now = now

    def time(self) -> float:
        return self.mono

    def dt(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.mono += seconds
        self.now += timedelta(seconds=seconds)


class S:  # minimal settings stub
    tz = "America/Los_Angeles"
    callmebot_phone = "+10000000000"
    callmebot_api_key = "k"


NOW = datetime(2026, 7, 6, 20, 0, tzinfo=timezone.utc)  # 13:00 LA — daytime


def make(db, adapters=None, now=NOW, ok=True):
    spy = SpySender(ok)
    clock = Clock(now)
    n = Notifier(
        adapters or {},
        db,
        S(),
        send_fn=spy,
        time_fn=clock.time,
        now_fn=clock.dt,
    )
    # rate-limit gap shouldn't slow tests down
    n._last_send_mono = -1e9  # noqa: SLF001
    return n, spy, clock


def litter_fake(**attrs):
    base = {
        "status_code": "RDY",
        "is_online": True,
        "is_waste_drawer_full": False,
        "litter_level_pct": 90,
    }
    base.update(attrs)
    return FakeAdapter(device_id="litterrobot", attributes=base)


def feeder_fake(**attrs):
    base = {"online": True, "dispenser_blocked": False, "food_low": False}
    base.update(attrs)
    return FakeAdapter(device_id="feeder", attributes=base)


# ── level rules ──────────────────────────────────────────────────────────


async def test_drawer_full_fires_once_then_cooldown(db):
    n, spy, clock = make(db, {"litterrobot": litter_fake(is_waste_drawer_full=True)})
    await n.tick()
    assert len(spy.sent) == 1 and "drawer is full" in spy.sent[0]
    await n.tick()  # persisting condition inside cooldown → no repeat
    assert len(spy.sent) == 1
    clock.advance(13 * 3600)  # past the 12h cooldown → gentle re-reminder
    await n.tick()
    assert len(spy.sent) == 2


@pytest.mark.parametrize(
    "adapters, phrase",
    [
        ({"litterrobot": litter_fake(status_code="PD")}, "fault (PD)"),
        ({"litterrobot": litter_fake(litter_level_pct=10)}, "very low (10%)"),
        ({"feeder": feeder_fake(dispenser_blocked=True)}, "jammed"),
        ({"feeder": feeder_fake(food_low=True)}, "running low"),
    ],
)
async def test_level_conditions(db, adapters, phrase):
    n, spy, _ = make(db, adapters)
    await n.tick()
    assert len(spy.sent) == 1 and phrase in spy.sent[0]


async def test_healthy_state_sends_nothing(db):
    n, spy, _ = make(db, {"litterrobot": litter_fake(), "feeder": feeder_fake()})
    await n.tick()
    assert spy.sent == []


async def test_offline_needs_ten_minutes_of_persistence(db):
    adapters = {"litterrobot": litter_fake(is_online=False)}
    n, spy, clock = make(db, adapters)
    await n.tick()  # first observation starts the grace clock
    assert spy.sent == []
    clock.advance(11 * 60)
    await n.tick()
    assert len(spy.sent) == 1 and "offline for 10+ minutes" in spy.sent[0]
    # back online clears the tracker
    adapters["litterrobot"].attributes["is_online"] = True
    await n.tick()
    assert len(spy.sent) == 1


# ── absence rules (cold-start honest) ────────────────────────────────────


async def test_absence_rules_skip_on_empty_or_shallow_db(db):
    n, spy, _ = make(db)
    await n.tick()  # empty DB → no history → no absence alarms
    assert spy.sent == []
    await seed_events(
        db,
        [{"device_id": "feeder", "event_type": "feed",
          "ts_utc": (NOW - timedelta(hours=2)).isoformat(), "source": "history"}],
    )
    await n.tick()  # only 2h of history → still silent
    assert spy.sent == []


async def test_no_cycle_and_no_feed_alerts_fire_with_history(db):
    old = (NOW - timedelta(hours=30)).isoformat()
    await seed_events(
        db,
        [
            {"device_id": "litterrobot", "event_type": "status_change",
             "ts_utc": old, "source": "poll", "data": {"from": "CCP", "to": "CCC"}},
            {"device_id": "feeder", "event_type": "feed",
             "ts_utc": (NOW - timedelta(hours=13)).isoformat(),
             "source": "history", "data": {"portions": 1}},
        ],
    )
    n, spy, _ = make(db)
    await n.tick()
    joined = " | ".join(spy.sent)
    assert "No clean cycle in the last 24 hours" in joined
    assert "Nothing dispensed in the last 12 hours" in joined


async def test_recent_cycle_and_feed_stay_quiet(db):
    await seed_events(
        db,
        [
            {"device_id": "litterrobot", "event_type": "activity",
             "ts_utc": (NOW - timedelta(hours=30)).isoformat(), "source": "history",
             "data": {"action": "Cat Detected"}},
            {"device_id": "litterrobot", "event_type": "status_change",
             "ts_utc": (NOW - timedelta(hours=3)).isoformat(), "source": "poll",
             "data": {"from": "CCP", "to": "CCC"}},
            {"device_id": "feeder", "event_type": "feed",
             "ts_utc": (NOW - timedelta(hours=4)).isoformat(),
             "source": "history", "data": {"portions": 1}},
        ],
    )
    n, spy, _ = make(db)
    await n.tick()
    assert spy.sent == []


# ── care digest ──────────────────────────────────────────────────────────

EVENING = datetime(2026, 7, 7, 2, 30, tzinfo=timezone.utc)  # 19:30 LA


async def test_care_digest_only_in_the_evening_and_only_once(db):
    await seed_events(
        db,
        [{"device_id": "care", "event_type": "care",
          "ts_utc": (EVENING - timedelta(hours=1)).isoformat(),
          "source": "owner", "data": {"task": "pet"}}],
    )
    n, spy, clock = make(db, now=NOW)  # 13:00 LA — too early
    await n.tick()
    assert spy.sent == []

    n2, spy2, clock2 = make(db, now=EVENING)
    await n2.tick()
    assert len(spy2.sent) == 1
    msg = spy2.sent[0]
    assert "Care reminders" in msg
    assert "brush his hair" in msg and "playtime" in msg and "pets 1/3" in msg
    await n2.tick()  # cooldown (20h) → once per evening
    assert len(spy2.sent) == 1


async def test_care_digest_quiet_when_everything_done(db):
    rows = [
        {"device_id": "care", "event_type": "care",
         "ts_utc": (EVENING - timedelta(hours=2)).isoformat(),
         "source": "owner", "data": {"task": t}}
        for t in ("brush", "play", "pet", "pet", "pet")
    ]
    await seed_events(db, rows)
    n, spy, _ = make(db, now=EVENING)
    await n.tick()
    assert spy.sent == []


# ── delivery bookkeeping ─────────────────────────────────────────────────


async def test_failed_send_recorded_and_retried_after_backoff(db):
    n, spy, clock = make(db, {"feeder": feeder_fake(food_low=True)}, ok=False)
    await n.tick()
    assert len(spy.sent) == 1
    await n.tick()  # failed <10min ago → suppressed (no hammering)
    assert len(spy.sent) == 1
    clock.advance(11 * 60)
    await n.tick()  # retry window open again
    assert len(spy.sent) == 2


async def test_test_endpoint_sends_and_ledgers(client, app, db):
    n, spy, _ = make(db)
    app.state.notifier = n
    try:
        resp = await client.post("/notify/test")
        assert resp.status_code == 200
        assert resp.json() == {"channel": "whatsapp", "delivered": True}
        assert spy.sent and "Test from Cat HQ" in spy.sent[0]
    finally:
        del app.state.notifier  # app fixture state persists across tests


async def test_test_endpoint_503_when_unconfigured(client, app, db):
    if hasattr(app.state, "notifier"):
        del app.state.notifier
    resp = await client.post("/notify/test")
    assert resp.status_code == 503


async def test_test_endpoint_requires_auth(anon_client, db):
    resp = await anon_client.post("/notify/test")
    assert resp.status_code == 401
