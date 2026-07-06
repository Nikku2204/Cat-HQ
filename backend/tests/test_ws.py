"""/ws endpoint tests (docs/04 Phase 1 — test_ws.py bullets).

httpx can't speak WebSocket, so these use starlette's TestClient as a
context manager: __enter__ runs the REAL lifespan (init_db against the
in-memory engine — the `db` fixture is therefore required by every test
here — and the hub started inside the client's portal loop). Fakes are
injected AFTER __enter__ because lifespan overwrites app.state.adapters
with {} (no vendor creds under the conftest env hardening). Publishing
through the hub from the test thread must hop into the portal loop —
asyncio queues aren't thread-safe: client.portal.call(hub.publish, msg).

Rejection detail (discovered empirically, starlette 1.3.1): the endpoint
calls close(code=4401) before accept(), which the TestClient surfaces as
WebSocketDisconnect(code=4401); real browsers see the handshake denied
(HTTP 403), per the endpoint docstring.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import TEST_TOKEN, FakeAdapter
from app.adapters.base import AdapterHealth, DeviceState, HealthStatus

FIXED_TS = datetime(2026, 7, 5, 19, 0, 0, tzinfo=timezone.utc)


# ── handshake auth ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "connect_kwargs",
    [
        pytest.param({}, id="no-token-at-all"),
        pytest.param(
            {"subprotocols": ["cathq", "wrong-token"]}, id="bad-subprotocol-token"
        ),
        # "cathq" is the protocol marker, never a valid token by itself
        pytest.param({"subprotocols": ["cathq"]}, id="cathq-only-no-token"),
        pytest.param(
            {"headers": {"Authorization": "Bearer wrong-token"}}, id="bad-bearer-header"
        ),
    ],
)
def test_handshake_rejected_without_valid_token(db, app, connect_kwargs):
    """No/bad token → handshake denied: connect raises, close code 4401."""
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect("/ws", **connect_kwargs):
                pass  # pragma: no cover — connect must not succeed
        assert excinfo.value.code == 4401


@pytest.mark.parametrize(
    "offers",
    [
        pytest.param(["cathq", TEST_TOKEN], id="cathq-first"),
        pytest.param([TEST_TOKEN, "cathq"], id="token-first"),
    ],
)
def test_subprotocol_cathq_echoed(db, app, offers):
    """Accepted browser-style handshake echoes "cathq" (RFC 6455: the server
    must pick one of the client's offers or browsers fail the connection),
    whatever position the token was offered in."""
    with TestClient(app) as client:
        with client.websocket_connect("/ws", subprotocols=offers) as ws:
            assert ws.accepted_subprotocol == "cathq"
            assert ws.receive_json()["kind"] == "hello"


def test_authorization_header_accepted_without_subprotocol(db, app):
    """Non-browser clients may authenticate via the Authorization header and
    offer no subprotocols — accepted, and NO subprotocol is echoed back."""
    with TestClient(app) as client:
        with client.websocket_connect(
            "/ws", headers={"Authorization": f"Bearer {TEST_TOKEN}"}
        ) as ws:
            assert ws.accepted_subprotocol is None
            assert ws.receive_json()["kind"] == "hello"


# ── hello snapshot ───────────────────────────────────────────────────────


def test_hello_snapshot_shape(db, app):
    """First frame is the hello with the full device snapshot:
    {"kind":"hello","devices":{id:{"health":..,"state":..}}}; state is the
    JSON-mode DeviceState dump when connected, null when disconnected
    (same fail-loud contract as REST)."""
    litter = FakeAdapter(attributes={"status_code": "RDY", "is_online": True})
    litter.fetched_at = FIXED_TS
    feeder = FakeAdapter(
        device_id="feeder",
        connected=False,
        health=AdapterHealth(
            status=HealthStatus.DEGRADED, detail="cloud flaky", consecutive_failures=2
        ),
    )
    with TestClient(app) as client:
        app.state.adapters["litterrobot"] = litter
        app.state.adapters["feeder"] = feeder
        with client.websocket_connect(
            "/ws", subprotocols=["cathq", TEST_TOKEN]
        ) as ws:
            hello = ws.receive_json()

    assert hello["kind"] == "hello"
    assert set(hello["devices"]) == {"litterrobot", "feeder"}
    assert hello["devices"]["litterrobot"] == {
        "health": AdapterHealth(status=HealthStatus.OK, detail="fake").model_dump(
            mode="json"
        ),
        "state": DeviceState(
            device_id="litterrobot",
            device_type="litterrobot",
            fetched_at_utc=FIXED_TS,
            attributes={"status_code": "RDY", "is_online": True},
        ).model_dump(mode="json"),
    }
    # disconnected → state null, health still reported (badge data)
    assert hello["devices"]["feeder"]["state"] is None
    assert hello["devices"]["feeder"]["health"] == feeder.health_obj.model_dump(
        mode="json"
    )


def test_hello_first_never_interleaved_with_broadcasts(db, app):
    """A client registers with the hub only AFTER its hello is sent: messages
    published before it connected never reach it, and its first frame is
    always the hello."""
    msg_early = {"kind": "state", "device_id": "litterrobot", "seq": 1}
    msg_late = {"kind": "state", "device_id": "litterrobot", "seq": 2}
    with TestClient(app) as client:
        hub = app.state.hub
        with client.websocket_connect(
            "/ws", subprotocols=["cathq", TEST_TOKEN]
        ) as ws1:
            assert ws1.receive_json()["kind"] == "hello"
            client.portal.call(hub.publish, msg_early)
            # blocking receive → fan-out of msg_early is COMPLETE before the
            # second client connects (no race on its registration)
            assert ws1.receive_json() == msg_early
            with client.websocket_connect(
                "/ws", subprotocols=["cathq", TEST_TOKEN]
            ) as ws2:
                assert ws2.receive_json()["kind"] == "hello"  # not msg_early
                client.portal.call(hub.publish, msg_late)
                assert ws2.receive_json() == msg_late  # next frame after hello
                assert ws1.receive_json() == msg_late


# ── hub broadcast fan-out ────────────────────────────────────────────────


def test_two_clients_both_receive_broadcast(db, app):
    """Two connected clients both receive a hub-published state message.

    This is the automated stand-in for the M4 two-client acceptance test
    (two /ws clients open while the owner watches the device — see
    docs/03-ROADMAP.md); the owner-watched hardware half still runs live.
    """
    state_msg = {
        "kind": "state",
        "device_id": "litterrobot",
        "health": {"status": "ok", "detail": ""},
        "state": {"attributes": {"status_code": "CCP"}},
    }
    follow_up = {"kind": "state", "device_id": "feeder", "state": None}
    with TestClient(app) as client:
        app.state.adapters["litterrobot"] = FakeAdapter(
            attributes={"status_code": "RDY"}
        )
        with client.websocket_connect(
            "/ws", subprotocols=["cathq", TEST_TOKEN]
        ) as ws1, client.websocket_connect(
            "/ws", subprotocols=["cathq", TEST_TOKEN]
        ) as ws2:
            # hellos arrive first, before any broadcast
            assert ws1.receive_json()["kind"] == "hello"
            assert ws2.receive_json()["kind"] == "hello"
            client.portal.call(app.state.hub.publish, state_msg)
            assert ws1.receive_json() == state_msg
            assert ws2.receive_json() == state_msg
            # order is stable per client (single-sender hub design)
            client.portal.call(app.state.hub.publish, follow_up)
            assert ws1.receive_json() == follow_up
            assert ws2.receive_json() == follow_up
