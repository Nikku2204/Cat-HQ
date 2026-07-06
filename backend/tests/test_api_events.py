"""GET /events — filters, windows, ordering, limits (docs/04 Phase 1).

All tests run in-process against the real app with the per-test in-memory
DB (`db` fixture); the authenticated `client` fixture carries the bearer
token. Seeded ts_utc strings use the canonical "+00:00" ISO form that
`normalize_iso` produces, so string comparisons in the WHERE clauses are
exercised exactly as production writes them.
"""
from __future__ import annotations

import pytest

from conftest import seed_events

# Five rows, ascending ts (ids 1..5 in insertion order), mixed devices/types.
SEED = [
    {"device_id": "litterrobot", "event_type": "clean_cycle",
     "ts_utc": "2026-07-05T00:00:00+00:00", "source": "history"},
    {"device_id": "feeder", "event_type": "feed",
     "ts_utc": "2026-07-05T01:00:00+00:00", "source": "history"},
    {"device_id": "litterrobot", "event_type": "status_change",
     "ts_utc": "2026-07-05T02:00:00+00:00", "source": "poll"},
    {"device_id": "feeder", "event_type": "food_low",
     "ts_utc": "2026-07-05T03:00:00+00:00", "source": "poll"},
    {"device_id": "litterrobot", "event_type": "clean_cycle",
     "ts_utc": "2026-07-05T04:00:00+00:00", "source": "command"},
]


def ts_of(body: dict) -> list[str]:
    return [e["ts_utc"] for e in body["events"]]


# ── shape + ordering ─────────────────────────────────────────────────────


async def test_all_events_shape_and_newest_first(client, db):
    """Unfiltered list: {count, events}, EventOut fields, newest-first."""
    await seed_events(db, SEED)
    resp = await client.get("/events")
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 5
    assert ts_of(body) == sorted((r["ts_utc"] for r in SEED), reverse=True)
    assert set(body["events"][0]) == {
        "id", "device_id", "event_type", "ts_utc", "source", "data",
    }
    assert body["events"][0]["data"] == {}


async def test_empty_db_returns_empty_list(client, db):
    resp = await client.get("/events")
    assert resp.status_code == 200
    assert resp.json() == {"count": 0, "events": []}


async def test_identical_ts_ordered_by_id_desc(client, db):
    """Stable ordering: ties on ts_utc break by id desc (insertion order
    reversed), so pagination never shuffles same-second rows."""
    ts = "2026-07-05T06:00:00+00:00"
    await seed_events(db, [
        {"device_id": "feeder", "event_type": "feed", "ts_utc": ts, "source": "poll"}
        for _ in range(3)
    ])
    resp = await client.get("/events")
    ids = [e["id"] for e in resp.json()["events"]]
    assert ids == sorted(ids, reverse=True)


# ── single filters ───────────────────────────────────────────────────────


@pytest.mark.parametrize("device,expected", [
    ("litterrobot", ["clean_cycle", "status_change", "clean_cycle"]),
    ("feeder", ["food_low", "feed"]),
])
async def test_device_filter(client, db, device, expected):
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"device": device})
    body = resp.json()
    assert all(e["device_id"] == device for e in body["events"])
    # newest-first within the filter
    assert [e["event_type"] for e in body["events"]] == expected


async def test_type_filter_uses_alias(client, db):
    """The query param is `type` (alias); the python name is not accepted."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"type": "clean_cycle"})
    body = resp.json()
    assert body["count"] == 2
    assert all(e["event_type"] == "clean_cycle" for e in body["events"])
    # `event_type=` is not a recognized param — silently ignored, all rows back
    resp = await client.get("/events", params={"event_type": "clean_cycle"})
    assert resp.json()["count"] == 5


async def test_unknown_device_422_with_helpful_detail(client, db):
    resp = await client.get("/events", params={"device": "camera"})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "camera" in detail
    assert "feeder" in detail and "litterrobot" in detail


# ── time windows ─────────────────────────────────────────────────────────


async def test_since_window(client, db):
    """since is inclusive (>=): the exact-match row comes back."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"since": "2026-07-05T02:00:00+00:00"})
    assert ts_of(resp.json()) == [
        "2026-07-05T04:00:00+00:00",
        "2026-07-05T03:00:00+00:00",
        "2026-07-05T02:00:00+00:00",
    ]


async def test_until_window_is_inclusive(client, db):
    """CONTRACT: a row whose ts_utc EXACTLY equals `until` is included.
    HistoryView pagination passes until=<oldest ts seen> and dedupes the
    boundary row client-side — excluding it here would drop events."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"until": "2026-07-05T02:00:00+00:00"})
    assert ts_of(resp.json()) == [
        "2026-07-05T02:00:00+00:00",  # the boundary row itself
        "2026-07-05T01:00:00+00:00",
        "2026-07-05T00:00:00+00:00",
    ]


async def test_since_until_combined_window(client, db):
    await seed_events(db, SEED)
    resp = await client.get("/events", params={
        "since": "2026-07-05T01:00:00+00:00",
        "until": "2026-07-05T03:00:00+00:00",
    })
    assert ts_of(resp.json()) == [
        "2026-07-05T03:00:00+00:00",
        "2026-07-05T02:00:00+00:00",
        "2026-07-05T01:00:00+00:00",
    ]


async def test_windows_normalize_non_utc_offsets(client, db):
    """normalize_iso canonicalizes offsets: 03:00+02:00 == 01:00Z, so the
    string comparison against stored '+00:00' rows still lands correctly."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"until": "2026-07-05T03:00:00+02:00"})
    assert ts_of(resp.json()) == [
        "2026-07-05T01:00:00+00:00",  # == the +02:00 boundary, inclusive
        "2026-07-05T00:00:00+00:00",
    ]
    # negative offset on since: 2026-07-04T21:00:00-05:00 == 02:00Z
    resp = await client.get("/events", params={"since": "2026-07-04T21:00:00-05:00"})
    assert resp.json()["count"] == 3


# ── limit ────────────────────────────────────────────────────────────────


async def test_limit_returns_newest_rows(client, db):
    await seed_events(db, SEED)
    resp = await client.get("/events", params={"limit": 2})
    assert ts_of(resp.json()) == [
        "2026-07-05T04:00:00+00:00",
        "2026-07-05T03:00:00+00:00",
    ]


@pytest.mark.parametrize("bad_limit", [0, 1001])
async def test_limit_bounds_422(client, db, bad_limit):
    resp = await client.get("/events", params={"limit": bad_limit})
    assert resp.status_code == 422


# ── combinations ─────────────────────────────────────────────────────────


async def test_all_filters_combined(client, db):
    """device + type + since + until + limit stack correctly."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={
        "device": "litterrobot",
        "type": "clean_cycle",
        "since": "2026-07-05T00:00:00+00:00",
        "until": "2026-07-05T04:00:00+00:00",
        "limit": 1,
    })
    body = resp.json()
    assert body["count"] == 1
    assert body["events"][0]["event_type"] == "clean_cycle"
    assert body["events"][0]["ts_utc"] == "2026-07-05T04:00:00+00:00"  # newest wins the limit


async def test_device_and_until_pagination_page(client, db):
    """The exact query HistoryView issues for 'load older' on one device."""
    await seed_events(db, SEED)
    resp = await client.get("/events", params={
        "device": "feeder", "until": "2026-07-05T01:00:00+00:00", "limit": 50,
    })
    body = resp.json()
    assert body["count"] == 1
    assert body["events"][0]["event_type"] == "feed"
