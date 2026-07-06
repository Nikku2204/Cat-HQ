"""Tests for backend/app/api/devices.py (docs/04 Phase 1, test_api_devices).

Covers: GET /devices shape + fail-loud null state, GET /devices/litterrobot
404/disconnected/200, POST clean 502 matrix over CLOUD_ERRORS + accepted=False
+ pass-through, GET /devices/feeder disconnected/connected, the feeder feed
matrix (FEEDER_CLOUD_ERRORS → 502, PetlibroSessionError → 503, portions bounds
via pydantic), and both /history endpoints (404/503/502 ladder, payload shape,
limit/days query bounds).

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
    """docs/04 originally specced 503 here; amended (same commit) to the
    route's fail-loud contract: 200 with state=null + the full health payload
    so the UI badge renders — same contract as GET /devices and GET
    /devices/feeder. 503-with-health-detail applies to the command/history
    endpoints (covered below)."""
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


# ── GET /devices/feeder ──────────────────────────────────────────────────


async def test_feeder_get_disconnected_returns_null_state(app, client):
    """Same fail-loud contract as GET /devices/litterrobot: 200 with
    state=null + the full health payload while disconnected, so the UI badge
    renders — 503-with-health-detail belongs to the command/history paths."""
    _feeder(
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.DEGRADED, detail="cloud poll failing"),
    )
    resp = await client.get("/devices/feeder")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] is None
    assert body["health"]["status"] == "degraded"
    assert body["health"]["detail"] == "cloud poll failing"


async def test_feeder_get_connected_200_with_state(app, client):
    _feeder(app, attributes={"grain_num": 12, "battery_state": "low"})
    resp = await client.get("/devices/feeder")
    assert resp.status_code == 200
    body = resp.json()
    assert body["health"]["status"] == "ok"
    assert body["state"]["attributes"] == {"grain_num": 12, "battery_state": "low"}


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


# ── GET /devices/{litterrobot,feeder}/history ────────────────────────────

# Both history endpoints share the 404/503/502 ladder (the amended docs/04
# contract lives here, on the command/history paths); they differ in the
# FakeAdapter hook that backs them, the cloud-error prefix, and the items key.
HISTORY_ENDPOINTS = {
    "litterrobot": {
        "install": _lr,
        "path": "/devices/litterrobot/history",
        "env_hint": "WHISKER_EMAIL",
        "data_attr": "activity",
        "exc_attr": "activity_exc",
        "cloud_exc": LitterRobotException("boom"),
        "cloud_prefix": "whisker cloud error:",
        "items_key": "activities",
    },
    "feeder": {
        "install": _feeder,
        "path": "/devices/feeder/history",
        "env_hint": "PETLIBRO_EMAIL",
        "data_attr": "feed_log",
        "exc_attr": "feed_log_exc",
        "cloud_exc": PetlibroError("boom"),
        "cloud_prefix": "petlibro cloud error:",
        "items_key": "events",
    },
}

history_matrix = pytest.mark.parametrize(
    "ep", HISTORY_ENDPOINTS.values(), ids=list(HISTORY_ENDPOINTS)
)


@history_matrix
async def test_history_404_when_adapter_absent(client, ep):
    resp = await client.get(ep["path"])
    assert resp.status_code == 404
    assert ep["env_hint"] in resp.json()["detail"]


@history_matrix
async def test_history_503_when_disconnected(app, client, ep):
    """Health detail must surface in the 503 body — the spec's disconnected
    contract on the history path."""
    ep["install"](
        app,
        connected=False,
        health=AdapterHealth(status=HealthStatus.ERROR, detail="cloud auth failed"),
    )
    resp = await client.get(ep["path"])
    assert resp.status_code == 503
    assert "cloud auth failed" in resp.json()["detail"]


@history_matrix
async def test_history_502_on_cloud_error(app, client, ep):
    """A representative cloud error from the history fetch maps to 502."""
    fake = ep["install"](app)
    setattr(fake, ep["exc_attr"], ep["cloud_exc"])
    resp = await client.get(ep["path"])
    assert resp.status_code == 502
    assert resp.json()["detail"].startswith(ep["cloud_prefix"])


async def test_feeder_history_session_error_maps_to_503(app, client):
    """PetlibroSessionError is a PetlibroError subclass but must hit the more
    specific 503 branch, not the 502 catch-all — same branch-order pin as the
    feed test above."""
    fake = _feeder(app)
    fake.feed_log_exc = PetlibroSessionError("contested")
    resp = await client.get("/devices/feeder/history")
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert detail.startswith("petlibro session lost:")
    assert "contested" in detail


@history_matrix
async def test_history_200_shape_and_limit_forwarding(app, client, ep):
    """{count, activities} vs {count, events}; limit reaches the adapter (the
    fake slices its scripted rows by it)."""
    fake = ep["install"](app)
    rows = [{"n": i} for i in range(5)]
    setattr(fake, ep["data_attr"], rows)
    resp = await client.get(ep["path"], params={"limit": 3})
    assert resp.status_code == 200
    assert resp.json() == {"count": 3, ep["items_key"]: rows[:3]}


@history_matrix
@pytest.mark.parametrize("limit", [0, 501])
async def test_history_limit_out_of_bounds_422(app, client, ep, limit):
    """Query bounds (1..500) reject before the handler runs — the scripted
    cloud error would turn this into a 502 if the adapter were reached."""
    fake = ep["install"](app)
    setattr(fake, ep["exc_attr"], ep["cloud_exc"])
    resp = await client.get(ep["path"], params={"limit": limit})
    assert resp.status_code == 422


@pytest.mark.parametrize("days", [0, 91])
async def test_feeder_history_days_out_of_bounds_422(app, client, days):
    """days bounds (1..90) are feeder-only; same reject-before-handler pin."""
    fake = _feeder(app)
    fake.feed_log_exc = PetlibroError("must not fire")
    resp = await client.get("/devices/feeder/history", params={"days": days})
    assert resp.status_code == 422
