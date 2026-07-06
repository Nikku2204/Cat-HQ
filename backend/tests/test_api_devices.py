"""Tests for backend/app/api/devices.py (docs/04 Phase 1, test_api_devices).

Covers: GET /devices shape + fail-loud null state, GET /devices/litterrobot
404/disconnected/200, POST clean 502 matrix over CLOUD_ERRORS + accepted=False
+ pass-through, and the feeder feed matrix (FEEDER_CLOUD_ERRORS → 502,
PetlibroSessionError → 503, portions bounds via pydantic).

All in-process with FakeAdapters — no network, no hardware (docs/04 rules 1-2).
"""
from __future__ import annotations

import aiohttp
import pytest
from botocore.exceptions import BotoCoreError
from botocore.exceptions import ClientError as CognitoClientError
from pylitterbot.exceptions import LitterRobotException

from conftest import FakeAdapter
from app.adapters.base import AdapterHealth, HealthStatus
from app.adapters.petlibro.client import (
    MAX_FEED_PORTIONS,
    PetlibroError,
    PetlibroSessionError,
)


def _lr(app, **kwargs) -> FakeAdapter:
    """Install a litterrobot FakeAdapter on the app and return it."""
    fake = FakeAdapter(device_id="litterrobot", **kwargs)
    app.state.adapters["litterrobot"] = fake
    return fake


def _feeder(app, **kwargs) -> FakeAdapter:
    """Install a feeder FakeAdapter on the app and return it."""
    fake = FakeAdapter(device_id="feeder", **kwargs)
    app.state.adapters["feeder"] = fake
    return fake


# ── GET /devices ─────────────────────────────────────────────────────────


async def test_all_devices_shape_and_fail_loud_null_state(app, client):
    """{devices:{id:{health,state}}}; state is null for a disconnected
    adapter (fail-loud contract), a real dict for a connected one."""
    _lr(app, attributes={"robot_status": "Ready"})
    _feeder(
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.ERROR, detail="session contested"),
    )

    resp = await client.get("/devices")
    assert resp.status_code == 200
    devices = resp.json()["devices"]
    assert set(devices) == {"litterrobot", "feeder"}

    lr = devices["litterrobot"]
    assert lr["health"]["status"] == "ok"
    assert lr["state"]["device_id"] == "litterrobot"
    assert lr["state"]["device_type"] == "litterrobot"
    assert lr["state"]["attributes"] == {"robot_status": "Ready"}
    assert "fetched_at_utc" in lr["state"]

    fd = devices["feeder"]
    assert fd["state"] is None  # never silently stale
    assert fd["health"] == {
        "status": "error",
        "detail": "session contested",
        "last_success_utc": None,
        "consecutive_failures": 0,
    }


async def test_all_devices_empty_when_nothing_configured(client):
    resp = await client.get("/devices")
    assert resp.status_code == 200
    assert resp.json() == {"devices": {}}


# ── GET /devices/litterrobot ─────────────────────────────────────────────


async def test_litterrobot_get_404_when_adapter_absent(client):
    resp = await client.get("/devices/litterrobot")
    assert resp.status_code == 404
    assert "WHISKER_EMAIL" in resp.json()["detail"]


async def test_litterrobot_get_disconnected_returns_null_state(app, client):
    """docs/04 says 503 here, but the endpoint (by its own docstring and the
    architecture's fail-loud rule) returns 200 with state=null + the health
    payload so the UI badge can show the detail — same contract as GET
    /devices and GET /devices/feeder. 503 applies to the command/history
    endpoints (covered below). Testing actual behavior; mismatch reported."""
    _lr(
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.ERROR, detail="cognito auth failed"),
    )
    resp = await client.get("/devices/litterrobot")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] is None
    assert body["health"]["status"] == "error"
    assert body["health"]["detail"] == "cognito auth failed"


async def test_litterrobot_get_connected_200_with_state(app, client):
    _lr(app, attributes={"robot_status": "Ready", "litter_level": 84})
    resp = await client.get("/devices/litterrobot")
    assert resp.status_code == 200
    body = resp.json()
    assert body["health"]["status"] == "ok"
    assert body["state"]["attributes"] == {"robot_status": "Ready", "litter_level": 84}


# ── POST /devices/litterrobot/clean ──────────────────────────────────────


async def test_litterrobot_clean_404_when_adapter_absent(client):
    resp = await client.post("/devices/litterrobot/clean")
    assert resp.status_code == 404
    assert "WHISKER_EMAIL" in resp.json()["detail"]


async def test_litterrobot_clean_503_when_disconnected(app, client):
    """Health detail must surface in the 503 body (the spec's disconnected
    contract, implemented on the command path)."""
    fake = _lr(
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.ERROR, detail="cognito auth failed"),
    )
    resp = await client.post("/devices/litterrobot/clean")
    assert resp.status_code == 503
    assert "cognito auth failed" in resp.json()["detail"]
    assert fake.executed == []  # never reached the adapter


CLEAN_CLOUD_ERROR_INSTANCES = [
    LitterRobotException("boom"),
    aiohttp.ClientError("boom"),
    TimeoutError("boom"),
    BotoCoreError(),
    CognitoClientError(
        {"Error": {"Code": "InternalErrorException", "Message": "x"}}, "InitiateAuth"
    ),
    KeyError("AccessToken"),  # pylitterbot's Cognito handler can KeyError
]


@pytest.mark.parametrize(
    "exc", CLEAN_CLOUD_ERROR_INSTANCES, ids=lambda e: type(e).__name__
)
async def test_litterrobot_clean_502_on_each_cloud_error(app, client, exc):
    """Every CLOUD_ERRORS member raised by the adapter maps to 502."""
    fake = _lr(app)
    fake.execute_exc = exc
    resp = await client.post("/devices/litterrobot/clean")
    assert resp.status_code == 502
    assert resp.json()["detail"].startswith("whisker cloud error:")
    assert [c.name for c in fake.executed] == ["start_clean"]


async def test_litterrobot_clean_502_when_cloud_rejects(app, client):
    fake = _lr(app)
    fake.execute_result = {"command": "start_clean", "accepted": False}
    resp = await client.post("/devices/litterrobot/clean")
    assert resp.status_code == 502
    assert "rejected" in resp.json()["detail"]


async def test_litterrobot_clean_200_passes_result_through(app, client):
    fake = _lr(app)
    fake.execute_result = {"command": "start_clean", "accepted": True, "robot": "LR4"}
    resp = await client.post("/devices/litterrobot/clean")
    assert resp.status_code == 200
    assert resp.json() == fake.execute_result  # verbatim pass-through
    assert len(fake.executed) == 1
    assert fake.executed[0].name == "start_clean"
    assert fake.executed[0].params == {}


# ── POST /devices/feeder/feed ────────────────────────────────────────────


async def test_feeder_feed_404_when_adapter_absent(client):
    resp = await client.post("/devices/feeder/feed", json={"portions": 1})
    assert resp.status_code == 404
    assert "PETLIBRO_EMAIL" in resp.json()["detail"]


async def test_feeder_feed_503_when_disconnected(app, client):
    fake = _feeder(
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.DEGRADED, detail="cloud poll failing"),
    )
    resp = await client.post("/devices/feeder/feed", json={"portions": 1})
    assert resp.status_code == 503
    assert "cloud poll failing" in resp.json()["detail"]
    assert fake.executed == []


FEEDER_CLOUD_ERROR_INSTANCES = [
    PetlibroError("boom"),
    aiohttp.ClientError("boom"),
    TimeoutError("boom"),
]


@pytest.mark.parametrize(
    "exc", FEEDER_CLOUD_ERROR_INSTANCES, ids=lambda e: type(e).__name__
)
async def test_feeder_feed_502_on_each_cloud_error(app, client, exc):
    """Every FEEDER_CLOUD_ERRORS member raised by the adapter maps to 502."""
    fake = _feeder(app)
    fake.execute_exc = exc
    resp = await client.post("/devices/feeder/feed", json={"portions": 2})
    assert resp.status_code == 502
    assert resp.json()["detail"].startswith("petlibro cloud error:")
    assert [c.name for c in fake.executed] == ["manual_feed"]


async def test_feeder_feed_session_error_maps_to_503(app, client):
    """PetlibroSessionError is a PetlibroError subclass but must hit the more
    specific 503 branch, not the 502 catch-all."""
    fake = _feeder(app)
    fake.execute_exc = PetlibroSessionError("contested")
    resp = await client.post("/devices/feeder/feed", json={"portions": 2})
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert detail.startswith("petlibro session lost:")
    assert "contested" in detail


async def test_feeder_feed_200_passes_result_through(app, client):
    fake = _feeder(app)
    fake.execute_result = {"command": "manual_feed", "portions": 2, "result": 1}
    resp = await client.post("/devices/feeder/feed", json={"portions": 2})
    assert resp.status_code == 200
    assert resp.json() == fake.execute_result  # verbatim pass-through
    assert len(fake.executed) == 1
    assert fake.executed[0].name == "manual_feed"
    assert fake.executed[0].params == {"portions": 2}


@pytest.mark.parametrize("portions", [0, 49])
async def test_feeder_feed_out_of_bounds_422_before_adapter(app, client, portions):
    """Pydantic rejects portions outside 1..MAX_FEED_PORTIONS(=48) before the
    handler runs — the adapter must never see the command."""
    assert MAX_FEED_PORTIONS == 48  # bounds below assume the upstream constant
    fake = _feeder(app)
    resp = await client.post("/devices/feeder/feed", json={"portions": portions})
    assert resp.status_code == 422
    assert fake.executed == []


@pytest.mark.parametrize("portions", [1, 48])
async def test_feeder_feed_boundary_portions_accepted(app, client, portions):
    fake = _feeder(app)
    resp = await client.post("/devices/feeder/feed", json={"portions": portions})
    assert resp.status_code == 200
    assert fake.executed[0].params == {"portions": portions}


async def test_feeder_feed_no_body_defaults_to_one_portion(app, client):
    fake = _feeder(app)
    resp = await client.post("/devices/feeder/feed")
    assert resp.status_code == 200
    assert fake.executed[0].name == "manual_feed"
    assert fake.executed[0].params == {"portions": 1}
