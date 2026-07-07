"""POST /care — owner-logged care events (M5.7 follow-on).

In-process against the real app + per-test in-memory DB. No network, no
hardware — logging a brush stroke moves nothing.
"""
from __future__ import annotations

import pytest


async def test_care_requires_auth(anon_client, db):
    resp = await anon_client.post("/care", json={"task": "brush"})
    assert resp.status_code == 401


@pytest.mark.parametrize("task", ["brush", "nails", "play", "pet", "water"])
async def test_log_each_task(client, db, task):
    resp = await client.post("/care", json={"task": task})
    assert resp.status_code == 200
    body = resp.json()
    assert body["device_id"] == "care"
    assert body["event_type"] == "care"
    assert body["source"] == "owner"
    assert body["data"] == {"task": task}
    assert body["ts_utc"]  # stamped server-side


async def test_unknown_task_rejected(client, db):
    resp = await client.post("/care", json={"task": "taxes"})
    assert resp.status_code == 422


async def test_logged_care_reads_back_via_events(client, db):
    await client.post("/care", json={"task": "pet"})
    await client.post("/care", json={"task": "pet"})
    resp = await client.get("/events", params={"device": "care"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    assert all(e["data"]["task"] == "pet" for e in body["events"])
    # and the type filter path works too
    resp2 = await client.get("/events", params={"type": "care"})
    assert resp2.json()["count"] == 2
