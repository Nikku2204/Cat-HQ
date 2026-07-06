"""Plug REST route tests (M5.5, docs/05 Part A).

HARD RULES (docs/04): in-process app + FakeAdapter only — no cloud, no
hardware. Covers the docs/05 error mapping: 404 unconfigured/non-plug,
503 disconnected, 409 busy, 429 rate-limited, 502 cloud, 401 unauthed.
"""
from __future__ import annotations

import aiohttp
import pytest

from app.adapters.govee import (
    GoveeAPIError,
    GoveeAuthError,
    GoveeHTTPError,
    GoveeRateLimitError,
    PowerBusyError,
)

from conftest import FakeAdapter

PLUG_ID = "plug_litterrobot"
PLUG_ATTRS = {"name": "litter robot plug", "model": "H5081", "online": True, "power_on": True}


def add_plug(app, **kwargs) -> FakeAdapter:
    fake = FakeAdapter(
        device_id=PLUG_ID,
        device_type="plug",
        attributes=dict(PLUG_ATTRS),
        **kwargs,
    )
    app.state.adapters[PLUG_ID] = fake
    return fake


# ── resolution / auth ────────────────────────────────────────────────────


@pytest.mark.parametrize("verb", ["on", "off", "cycle"])
async def test_404_when_no_plug_configured(client, verb):
    resp = await client.post(f"/devices/{PLUG_ID}/{verb}")
    assert resp.status_code == 404
    assert "GOVEE_API_KEY" in resp.json()["detail"]


async def test_404_for_non_plug_device_id(app, client):
    # even with a litterrobot adapter present, /devices/litterrobot/cycle
    # must never resolve to a power command
    app.state.adapters["litterrobot"] = FakeAdapter()
    resp = await client.post("/devices/litterrobot/cycle")
    assert resp.status_code == 404


async def test_404_when_adapter_at_plug_id_is_not_a_plug(app, client):
    app.state.adapters[PLUG_ID] = FakeAdapter(device_id=PLUG_ID, device_type="feeder")
    resp = await client.post(f"/devices/{PLUG_ID}/cycle")
    assert resp.status_code == 404


@pytest.mark.parametrize("verb", ["on", "off", "cycle"])
async def test_401_without_token(app, anon_client, verb):
    add_plug(app)
    resp = await anon_client.post(f"/devices/{PLUG_ID}/{verb}")
    assert resp.status_code == 401


# ── connection state ─────────────────────────────────────────────────────


async def test_503_when_not_connected(app, client):
    from app.adapters.base import AdapterHealth, HealthStatus

    add_plug(
        app,
        connected=False,
        health=AdapterHealth(
            status=HealthStatus.ERROR, detail="plug name 'x' not found"
        ),
    )
    resp = await client.post(f"/devices/{PLUG_ID}/cycle")
    assert resp.status_code == 503
    assert "not found" in resp.json()["detail"]


# ── command dispatch + error mapping ─────────────────────────────────────


@pytest.mark.parametrize(
    ("verb", "command"),
    [("on", "power_on"), ("off", "power_off"), ("cycle", "power_cycle")],
)
async def test_happy_path_dispatches_command(app, client, verb, command):
    fake = add_plug(app)
    fake.execute_result = {"command": command, "accepted": True}
    resp = await client.post(f"/devices/{PLUG_ID}/{verb}")
    assert resp.status_code == 200
    assert resp.json() == {"command": command, "accepted": True}
    assert [c.name for c in fake.executed] == [command]


async def test_409_when_power_command_already_running(app, client):
    fake = add_plug(app)
    fake.execute_exc = PowerBusyError("a power command is already running")
    resp = await client.post(f"/devices/{PLUG_ID}/cycle")
    assert resp.status_code == 409
    assert "already running" in resp.json()["detail"]


async def test_429_when_rate_limited(app, client):
    fake = add_plug(app)
    fake.execute_exc = GoveeRateLimitError(30.0)
    resp = await client.post(f"/devices/{PLUG_ID}/on")
    assert resp.status_code == 429
    assert "rate limit" in resp.json()["detail"]


@pytest.mark.parametrize(
    "exc",
    [
        GoveeHTTPError(500, "boom"),
        GoveeAPIError(400, "bad request"),
        GoveeAuthError("API key rejected"),
        aiohttp.ClientError("conn reset"),
        TimeoutError(),
    ],
    ids=["http", "api", "auth", "transport", "timeout"],
)
async def test_502_on_cloud_errors(app, client, exc):
    fake = add_plug(app)
    fake.execute_exc = exc
    resp = await client.post(f"/devices/{PLUG_ID}/cycle")
    assert resp.status_code == 502
    assert "govee cloud error" in resp.json()["detail"]


# ── discovery surface ────────────────────────────────────────────────────


async def test_plug_appears_in_devices_collection(app, client):
    add_plug(app)
    resp = await client.get("/devices")
    assert resp.status_code == 200
    entry = resp.json()["devices"][PLUG_ID]
    assert entry["health"]["status"] == "ok"
    assert entry["state"]["attributes"]["power_on"] is True
    assert entry["state"]["device_type"] == "plug"
