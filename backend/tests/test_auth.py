"""Auth tests (docs/04-TESTING.md Phase 1 — test_auth.py).

REST: bearer-token 401 matrix on /devices and /events, 200 with the right
token, WWW-Authenticate on every 401, /health and / open without a token.
WS: `ws_authenticated()` / `ws_offered_subprotocols()` are pure header
functions — exercised with fabricated header objects, no real WebSocket.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.auth as auth
import app.main as app_main
from conftest import TEST_TOKEN

PROTECTED_PATHS = ["/devices", "/events"]

# (headers, id) for every way a request can fail bearer auth. httpx merges
# per-request headers over the client's, so anon_client + these = the matrix.
BAD_AUTH_HEADERS = [
    pytest.param({}, id="no-header"),
    pytest.param({"Authorization": "Basic x"}, id="wrong-scheme"),
    pytest.param({"Authorization": f"Bearer not-{TEST_TOKEN}"}, id="wrong-token"),
    pytest.param({"Authorization": "Bearer "}, id="empty-bearer"),
]


# ── REST 401 matrix ──────────────────────────────────────────────────────


@pytest.mark.parametrize("path", PROTECTED_PATHS)
@pytest.mark.parametrize("headers", BAD_AUTH_HEADERS)
async def test_protected_route_rejects_bad_auth(anon_client, path, headers):
    """Every bad-credential shape → 401 with the WWW-Authenticate challenge.
    (401 fires in the dependency, before any handler/DB code runs.)"""
    resp = await anon_client.get(path, headers=headers)
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


async def test_devices_ok_with_token(client):
    """Right token → 200. No adapters injected, so the map is empty."""
    resp = await client.get("/devices")
    assert resp.status_code == 200
    assert resp.json() == {"devices": {}}


async def test_events_ok_with_token(client, db):
    """Right token → 200 against a real (empty) in-memory DB."""
    resp = await client.get("/events")
    assert resp.status_code == 200
    assert resp.json() == {"count": 0, "events": []}


# ── open routes: /health and / ───────────────────────────────────────────


async def test_health_needs_no_token(anon_client):
    resp = await anon_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["adapters"] == {}  # app fixture injects no adapters


async def test_root_needs_no_token(anon_client, monkeypatch, tmp_path):
    """PWA shell contract: / is open. With no frontend build the JSON hint
    stands in for index.html (STATIC_DIR pinned empty for determinism)."""
    monkeypatch.setattr(app_main, "STATIC_DIR", tmp_path)
    resp = await anon_client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"app", "hint"}


# ── ws_offered_subprotocols(): pure header parsing ───────────────────────


def _ws(headers: dict[str, str]):
    """ws_* only calls ws.headers.get(<lowercase key>) — a stub suffices."""
    return SimpleNamespace(headers=headers)


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        pytest.param("cathq, tok", ["cathq", "tok"], id="spaced"),
        pytest.param("cathq,tok", ["cathq", "tok"], id="unspaced"),
        pytest.param("  cathq ,  tok  ", ["cathq", "tok"], id="padded"),
        pytest.param("", [], id="empty-header"),
        pytest.param(" , ,", [], id="only-separators"),
    ],
)
def test_ws_offered_subprotocols_parsing(header, expected):
    assert auth.ws_offered_subprotocols(_ws({"sec-websocket-protocol": header})) == expected


def test_ws_offered_subprotocols_header_absent():
    assert auth.ws_offered_subprotocols(_ws({})) == []


# ── ws_authenticated(): subprotocol offers ───────────────────────────────


@pytest.mark.parametrize(
    "header",
    [
        pytest.param(f"{TEST_TOKEN}, cathq", id="token-first"),
        pytest.param(f"cathq, {TEST_TOKEN}, bogus", id="token-middle"),
        pytest.param(f"cathq, {TEST_TOKEN}", id="token-last"),
        pytest.param(f"cathq,{TEST_TOKEN}", id="no-spaces"),
        pytest.param(f"  cathq ,   {TEST_TOKEN}  ", id="extra-spaces"),
        pytest.param(TEST_TOKEN, id="token-only-no-marker"),
    ],
)
def test_ws_valid_token_any_offer_position(header):
    assert auth.ws_authenticated(_ws({"sec-websocket-protocol": header})) is True


@pytest.mark.parametrize(
    "header",
    [
        pytest.param("", id="empty-header"),
        pytest.param("cathq", id="marker-only"),
        pytest.param("cathq, nope, also-wrong", id="multiple-bogus"),
        pytest.param("nope,also-wrong,still-wrong", id="bogus-no-marker"),
        pytest.param(f"cathq, {TEST_TOKEN.upper()}", id="wrong-case-token"),
    ],
)
def test_ws_bad_offers_rejected(header):
    assert auth.ws_authenticated(_ws({"sec-websocket-protocol": header})) is False


def test_ws_no_headers_at_all():
    assert auth.ws_authenticated(_ws({})) is False


# ── ws_authenticated(): Authorization header path ────────────────────────


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "BeArEr"])
def test_ws_authorization_header_scheme_case_insensitive(scheme):
    assert auth.ws_authenticated(_ws({"authorization": f"{scheme} {TEST_TOKEN}"})) is True


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(f"Basic {TEST_TOKEN}", id="wrong-scheme"),
        pytest.param(f"Bearer not-{TEST_TOKEN}", id="wrong-token"),
        pytest.param("Bearer ", id="empty-token"),
        pytest.param("", id="empty-value"),
    ],
)
def test_ws_authorization_header_rejected(value):
    assert auth.ws_authenticated(_ws({"authorization": value})) is False


# ── the marker is never a token ──────────────────────────────────────────


def test_ws_marker_equal_to_configured_token_not_accepted(monkeypatch):
    """Even if CATHQ_AUTH_TOKEN were literally "cathq", the protocol marker
    offer must be skipped — offering just ["cathq"] never authenticates."""
    monkeypatch.setattr(
        auth, "get_settings", lambda: SimpleNamespace(cathq_auth_token="cathq")
    )
    assert auth.ws_authenticated(_ws({"sec-websocket-protocol": "cathq"})) is False
    # repeating the marker doesn't help either
    assert auth.ws_authenticated(_ws({"sec-websocket-protocol": "cathq, cathq"})) is False
