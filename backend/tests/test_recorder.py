"""Recorder — state diffs, snapshot upserts, baseline seeding, history
ingest idempotency, health transitions (docs/04 Phase 2).

Pure-logic tests: Recorder is built directly over the per-test in-memory
DB (`db` fixture) with conftest FakeAdapters — no network, no loops. The
sleeping loops are never started; the seams (`_seed_baseline`,
`_sample_all`, `_ingest_history`) are awaited directly.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.adapters.base import AdapterHealth, HealthStatus
from app.models import DeviceStateRow, Event
from app.pollers import Recorder
from conftest import FakeAdapter

# Baseline attribute sets — every TRACKED_FIELD present, plus one
# untracked field per device to prove the diff ignores it.
LR_BASE = {
    "status_code": "RDY",
    "is_online": True,
    "waste_drawer_level_pct": 40,
    "is_waste_drawer_full": False,
    "litter_level_state": "optimal",
    "pet_weight_lbs": 9.4,
    "firmware": "1.0.0",  # NOT in TRACKED_FIELDS
}
FEEDER_BASE = {
    "online": True,
    "food_low": False,
    "dispenser_blocked": False,
    "running_state": "IDLE",
    "today_feed_count": 3,
    "battery_pct": 80,  # NOT in TRACKED_FIELDS
}

LR_ACTIVITY = [
    {"timestamp_utc": "2026-07-05T10:00:00+00:00", "action": "Clean Cycle Complete"},
]
FEED_LOG = [
    {"timestamp_utc": "2026-07-05T09:00:00+00:00", "portions": 2},
]


# ── local helpers ────────────────────────────────────────────────────────


class SpyAdapter(FakeAdapter):
    """FakeAdapter that counts history calls — proves disconnected
    adapters are never asked for vendor history at all."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.activity_calls = 0
        self.feed_log_calls = 0

    async def get_activity(self, limit: int = 50):
        self.activity_calls += 1
        return await super().get_activity(limit)

    async def get_feed_log(self, days: int = 7, limit: int = 50):
        self.feed_log_calls += 1
        return await super().get_feed_log(days, limit)


async def fetch_events(db) -> list[Event]:
    async with db() as session:
        return list((await session.execute(select(Event).order_by(Event.id))).scalars())


async def fetch_snapshots(db) -> dict[str, DeviceStateRow]:
    async with db() as session:
        rows = (await session.execute(select(DeviceStateRow))).scalars()
        return {r.device_id: r for r in rows}


@pytest.fixture
def fake_lr():
    return FakeAdapter(device_id="litterrobot", attributes=LR_BASE)


@pytest.fixture
def fake_feeder():
    return FakeAdapter(device_id="feeder", attributes=FEEDER_BASE)


@pytest.fixture
def recorder(db, fake_lr, fake_feeder):
    return Recorder({"litterrobot": fake_lr, "feeder": fake_feeder}, db)


# ── state diff ───────────────────────────────────────────────────────────


async def test_first_sample_is_baseline_no_events_snapshots_written(recorder, db):
    """First _sample_all establishes the diff baseline: NO events yet,
    but a snapshot row per connected device with attrs + health json."""
    await recorder._sample_all()
    assert await fetch_events(db) == []
    snaps = await fetch_snapshots(db)
    assert set(snaps) == {"litterrobot", "feeder"}
    assert snaps["litterrobot"].attributes == LR_BASE
    assert snaps["feeder"].attributes == FEEDER_BASE
    assert snaps["litterrobot"].health["status"] == "ok"


# Full TRACKED_FIELDS matrix: each change → exactly one event of the
# mapped type. The "from" value comes from the base dicts above.
TRACKED_MATRIX = [
    ("litterrobot", "status_code", "CCP", "status_change"),
    ("litterrobot", "is_online", False, "connectivity"),
    ("litterrobot", "waste_drawer_level_pct", 55, "drawer_level_change"),
    ("litterrobot", "is_waste_drawer_full", True, "drawer_full"),
    ("litterrobot", "litter_level_state", "low", "litter_level_change"),
    ("litterrobot", "pet_weight_lbs", 9.8, "pet_weight"),
    ("feeder", "online", False, "connectivity"),
    ("feeder", "food_low", True, "food_low"),
    ("feeder", "dispenser_blocked", True, "dispenser_blocked"),
    ("feeder", "running_state", "FEEDING", "running_state"),
    ("feeder", "today_feed_count", 4, "feed_count_change"),
]


@pytest.mark.parametrize("device_id,field,new,event_type", TRACKED_MATRIX)
async def test_tracked_field_change_emits_typed_event(
    recorder, fake_lr, fake_feeder, db, device_id, field, new, event_type
):
    fakes = {"litterrobot": fake_lr, "feeder": fake_feeder}
    await recorder._sample_all()  # baseline
    old = fakes[device_id].attributes[field]
    fakes[device_id].attributes[field] = new
    await recorder._sample_all()
    events = await fetch_events(db)
    assert len(events) == 1
    ev = events[0]
    assert (ev.device_id, ev.event_type, ev.source) == (device_id, event_type, "poll")
    assert ev.data == {"field": field, "from": old, "to": new}
    assert ev.dedupe_key is None  # poll events never dedupe


async def test_two_changes_same_sample_one_event_each(recorder, fake_lr, db):
    await recorder._sample_all()
    fake_lr.attributes["status_code"] = "CCP"
    fake_lr.attributes["waste_drawer_level_pct"] = 55
    await recorder._sample_all()
    events = await fetch_events(db)
    assert {e.event_type for e in events} == {"status_change", "drawer_level_change"}
    assert len(events) == 2


async def test_untracked_field_change_no_event_snapshot_still_updates(
    recorder, fake_lr, db
):
    await recorder._sample_all()
    fake_lr.attributes["firmware"] = "2.0.0"
    await recorder._sample_all()
    assert await fetch_events(db) == []
    snaps = await fetch_snapshots(db)
    assert snaps["litterrobot"].attributes["firmware"] == "2.0.0"


async def test_identical_samples_emit_no_events(recorder, db):
    await recorder._sample_all()
    await recorder._sample_all()
    await recorder._sample_all()
    assert await fetch_events(db) == []


async def test_tracked_field_absent_from_sample_is_not_diffed(recorder, fake_lr, db):
    """`field in attrs` guard: a vendor omitting a field one cycle must
    not fire a spurious value→None event."""
    await recorder._sample_all()
    del fake_lr.attributes["status_code"]
    await recorder._sample_all()
    assert await fetch_events(db) == []


async def test_snapshot_upsert_one_row_per_device_latest_wins(
    recorder, fake_lr, db
):
    """Three samples with mutations in between: still exactly one
    device_state row per device, holding the LAST sampled attributes."""
    await recorder._sample_all()
    fake_lr.attributes["status_code"] = "CCP"
    await recorder._sample_all()
    fake_lr.attributes["status_code"] = "RDY"
    fake_lr.attributes["waste_drawer_level_pct"] = 60
    await recorder._sample_all()
    snaps = await fetch_snapshots(db)
    assert set(snaps) == {"litterrobot", "feeder"}  # no duplicate rows
    assert snaps["litterrobot"].attributes["status_code"] == "RDY"
    assert snaps["litterrobot"].attributes["waste_drawer_level_pct"] == 60
    assert snaps["feeder"].attributes == FEEDER_BASE


# ── baseline seeding across restart ──────────────────────────────────────


async def test_restart_diffs_against_persisted_snapshot(db, fake_lr, fake_feeder):
    """M3 acceptance: a change that happens while the backend is down is
    still detected — the new Recorder seeds its baseline from the DB."""
    rec1 = Recorder({"litterrobot": fake_lr, "feeder": fake_feeder}, db)
    await rec1._sample_all()  # persist snapshots, then "restart"

    fake_lr.attributes["status_code"] = "CCP"  # changed during downtime
    rec2 = Recorder({"litterrobot": fake_lr, "feeder": fake_feeder}, db)
    await rec2._seed_baseline()
    await rec2._sample_all()

    events = await fetch_events(db)
    assert len(events) == 1  # unchanged attrs (incl. all of feeder) stay silent
    assert events[0].event_type == "status_change"
    assert events[0].data == {"field": "status_code", "from": "RDY", "to": "CCP"}


async def test_restart_unchanged_attrs_stay_silent(db, fake_lr, fake_feeder):
    rec1 = Recorder({"litterrobot": fake_lr, "feeder": fake_feeder}, db)
    await rec1._sample_all()
    rec2 = Recorder({"litterrobot": fake_lr, "feeder": fake_feeder}, db)
    await rec2._seed_baseline()
    await rec2._sample_all()
    assert await fetch_events(db) == []


async def test_restart_health_baseline_detects_flip_across_downtime(db, fake_lr):
    """_seed_baseline also restores _prev_health from the snapshot's
    health json, so a status flip across downtime emits health_change on
    the very first post-restart sample."""
    rec1 = Recorder({"litterrobot": fake_lr}, db)
    await rec1._sample_all()  # persists health {"status": "ok", ...}

    fake_lr.health_obj = AdapterHealth(status=HealthStatus.ERROR, detail="expired session")
    rec2 = Recorder({"litterrobot": fake_lr}, db)
    await rec2._seed_baseline()
    await rec2._sample_all()

    changes = [e for e in await fetch_events(db) if e.event_type == "health_change"]
    assert len(changes) == 1
    assert changes[0].data == {"from": "ok", "to": "error", "detail": "expired session"}


# ── history ingest ───────────────────────────────────────────────────────


async def test_ingest_history_writes_rows_and_is_idempotent(
    recorder, fake_lr, fake_feeder, db
):
    fake_lr.activity = list(LR_ACTIVITY)
    fake_feeder.feed_log = list(FEED_LOG)
    await recorder._ingest_history()

    events = {e.device_id: e for e in await fetch_events(db)}
    assert set(events) == {"litterrobot", "feeder"}
    lr = events["litterrobot"]
    assert (lr.event_type, lr.source) == ("activity", "history")
    assert lr.ts_utc == "2026-07-05T10:00:00+00:00"
    assert lr.data == {"action": "Clean Cycle Complete"}
    assert lr.dedupe_key == "lr:2026-07-05T10:00:00+00:00:Clean Cycle Complete"
    fd = events["feeder"]
    assert (fd.event_type, fd.source) == ("feed", "history")
    assert fd.data == {"portions": 2}
    assert fd.dedupe_key == "pl:2026-07-05T09:00:00+00:00:2"

    # same vendor rows again: dedupe_key UNIQUE + do_nothing → no dupes
    await recorder._ingest_history()
    assert len(await fetch_events(db)) == 2


async def test_ingest_dedupes_old_rows_but_accepts_new_ones(
    recorder, fake_lr, fake_feeder, db
):
    """Idempotent, not frozen: a new vendor row alongside already-seen
    ones still lands on the next cycle."""
    fake_lr.activity = list(LR_ACTIVITY)
    fake_feeder.feed_log = list(FEED_LOG)
    await recorder._ingest_history()
    fake_lr.activity = LR_ACTIVITY + [
        {"timestamp_utc": "2026-07-05T12:00:00+00:00", "action": "Pet Weight Recorded"}
    ]
    await recorder._ingest_history()
    events = await fetch_events(db)
    assert len(events) == 3
    assert [e.ts_utc for e in events if e.device_id == "litterrobot"] == [
        "2026-07-05T10:00:00+00:00",
        "2026-07-05T12:00:00+00:00",
    ]


async def test_feeder_rows_without_timestamp_skipped_row_by_row(
    recorder, fake_feeder, db
):
    """A None timestamp (vendor sends them) skips ONLY that row — rows
    before and after it in the same batch still land."""
    fake_feeder.feed_log = [
        {"timestamp_utc": "2026-07-05T08:00:00+00:00", "portions": 1},
        {"timestamp_utc": None, "portions": 1},
        {"timestamp_utc": "2026-07-05T09:00:00+00:00", "portions": 2},
    ]
    await recorder._ingest_history()
    events = await fetch_events(db)
    assert [e.ts_utc for e in events] == [
        "2026-07-05T08:00:00+00:00",
        "2026-07-05T09:00:00+00:00",
    ]


async def test_malformed_row_skipped_rest_of_batch_still_lands(
    recorder, fake_lr, fake_feeder, db
):
    """The docs/04 known gap, closed (M5.5 feature session): a malformed
    vendor row is skipped row-by-row — rows before AND after it in the
    same batch still insert, so a bad row sitting in the fetch window can
    no longer shadow newer rows. Feeder rows land regardless (per-adapter
    isolation unchanged).
    """
    fake_lr.activity = [
        {"timestamp_utc": "2026-07-05T08:00:00+00:00", "action": "Clean Cycle In Progress"},
        {"timestamp_utc": "not-a-timestamp", "action": "Bad Row"},
        {"timestamp_utc": "2026-07-05T10:00:00+00:00", "action": "Clean Cycle Complete"},
    ]
    fake_feeder.feed_log = list(FEED_LOG)
    await recorder._ingest_history()
    events = await fetch_events(db)
    lr_ts = [e.ts_utc for e in events if e.device_id == "litterrobot"]
    assert lr_ts == [
        "2026-07-05T08:00:00+00:00",
        "2026-07-05T10:00:00+00:00",  # the row AFTER the bad one survives
    ]
    assert [e.device_id for e in events if e.device_id == "feeder"] == ["feeder"]


async def test_malformed_feeder_row_skipped_row_by_row(
    recorder, fake_feeder, db
):
    """Same per-row isolation on the feeder side (portions KeyError)."""
    fake_feeder.feed_log = [
        {"timestamp_utc": "2026-07-05T08:00:00+00:00", "portions": 1},
        {"timestamp_utc": "2026-07-05T08:30:00+00:00"},  # no portions key
        {"timestamp_utc": "2026-07-05T09:00:00+00:00", "portions": 2},
    ]
    await recorder._ingest_history()
    events = await fetch_events(db)
    assert [e.ts_utc for e in events] == [
        "2026-07-05T08:00:00+00:00",
        "2026-07-05T09:00:00+00:00",
    ]


async def test_one_adapter_raising_does_not_block_the_other(
    recorder, fake_lr, fake_feeder, db
):
    """Vendor cloud down for litterrobot: feeder ingest still succeeds."""
    fake_lr.activity_exc = RuntimeError("cloud down")
    fake_feeder.feed_log = list(FEED_LOG)
    await recorder._ingest_history()
    events = await fetch_events(db)
    assert [e.device_id for e in events] == ["feeder"]
    assert events[0].data == {"portions": 2}


async def test_disconnected_adapters_skipped_by_history_ingest(db):
    """connected=False → get_activity/get_feed_log are never even called
    and nothing is written."""
    lr = SpyAdapter(device_id="litterrobot", connected=False, attributes=LR_BASE)
    feeder = SpyAdapter(device_id="feeder", connected=False, attributes=FEEDER_BASE)
    lr.activity = list(LR_ACTIVITY)
    feeder.feed_log = list(FEED_LOG)
    rec = Recorder({"litterrobot": lr, "feeder": feeder}, db)
    await rec._ingest_history()
    assert (lr.activity_calls, feeder.feed_log_calls) == (0, 0)
    assert await fetch_events(db) == []


# ── health tracking ──────────────────────────────────────────────────────


async def test_no_health_change_on_first_sample(recorder, fake_lr, db):
    """No baseline on the very first sample — even an adapter that starts
    out in ERROR does not emit health_change."""
    fake_lr.health_obj = AdapterHealth(status=HealthStatus.ERROR, detail="boom")
    await recorder._sample_all()
    assert await fetch_events(db) == []


async def test_health_transition_emits_health_change_once(recorder, fake_lr, db):
    await recorder._sample_all()  # baseline: ok
    fake_lr.health_obj = AdapterHealth(status=HealthStatus.ERROR, detail="boom")
    await recorder._sample_all()

    events = await fetch_events(db)
    assert len(events) == 1
    ev = events[0]
    assert (ev.device_id, ev.event_type, ev.source) == ("litterrobot", "health_change", "poll")
    assert ev.data == {"from": "ok", "to": "error", "detail": "boom"}
    # snapshot health follows the transition
    assert (await fetch_snapshots(db))["litterrobot"].health["status"] == "error"

    # same status again: no second health_change
    await recorder._sample_all()
    assert len(await fetch_events(db)) == 1


async def test_sample_all_tracks_health_of_disconnected_adapter(db):
    """Disconnected adapters are skipped for state/snapshots (fail-loud:
    never persist stale attrs) but their health is still baselined and
    diffed — the badge flip must produce an event."""
    lr = FakeAdapter(device_id="litterrobot", connected=False, attributes=LR_BASE)
    rec = Recorder({"litterrobot": lr}, db)
    await rec._sample_all()  # health baseline noted; nothing written
    assert await fetch_events(db) == []
    assert await fetch_snapshots(db) == {}

    lr.health_obj = AdapterHealth(status=HealthStatus.ERROR, detail="boom")
    await rec._sample_all()
    events = await fetch_events(db)
    assert len(events) == 1
    assert events[0].event_type == "health_change"
    assert events[0].data == {"from": "ok", "to": "error", "detail": "boom"}
    assert await fetch_snapshots(db) == {}  # still no snapshot while disconnected
