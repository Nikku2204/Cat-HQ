"""Govee v1 client unit tests (M5.5, docs/05 Part A).

HARD RULE (docs/04): tests never touch vendor clouds — everything below runs
against a hand-rolled fake aiohttp session, no network I/O anywhere.
"""
from __future__ import annotations

from typing import Any

import pytest

from app.adapters.govee.client import (
    BASE_URL,
    GoveeAPIError,
    GoveeAuthError,
    GoveeClient,
    GoveeError,
    GoveeHTTPError,
    GoveeRateLimitError,
)

API_KEY = "test-govee-key"


# ── fake aiohttp session ─────────────────────────────────────────────────


class FakeResponse:
    def __init__(
        self,
        status: int = 200,
        body: Any = None,
        headers: dict[str, str] | None = None,
        json_exc: bool = False,
    ) -> None:
        self.status = status
        self._body = body
        self.headers = headers or {}
        self._json_exc = json_exc

    async def json(self, content_type: str | None = None) -> Any:
        if self._json_exc:
            raise ValueError("not json")
        return self._body


class _Ctx:
    def __init__(self, resp: FakeResponse) -> None:
        self._resp = resp

    async def __aenter__(self) -> FakeResponse:
        return self._resp

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class FakeSession:
    """Stands in for aiohttp.ClientSession; responses consumed in order."""

    def __init__(self, *responses: FakeResponse) -> None:
        self.calls: list[dict[str, Any]] = []
        self._responses = list(responses)
        self.closed = False

    def request(self, method: str, url: str, **kwargs: Any) -> _Ctx:
        self.calls.append({"method": method, "url": url, **kwargs})
        return _Ctx(self._responses.pop(0))

    async def close(self) -> None:
        self.closed = True


def make_client(*responses: FakeResponse) -> tuple[GoveeClient, FakeSession]:
    session = FakeSession(*responses)
    return GoveeClient(API_KEY, session=session), session  # type: ignore[arg-type]


def envelope(data: Any) -> dict[str, Any]:
    return {"data": data, "message": "Success", "code": 200}


PLUG_ROW = {
    "device": "AA:BB:CC:DD:EE:FF:11:22",
    "model": "H5081",
    "deviceName": "litter robot plug",
    "controllable": True,
    "retrievable": True,
    "supportCmds": ["turn"],
}


# ── happy paths ──────────────────────────────────────────────────────────


async def test_devices_parses_list_and_sends_key_header():
    client, session = make_client(FakeResponse(body=envelope({"devices": [PLUG_ROW]})))
    devices = await client.devices()
    assert devices == [PLUG_ROW]
    call = session.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == BASE_URL + "/devices"
    assert call["headers"] == {"Govee-API-Key": API_KEY}


async def test_devices_empty_data_returns_empty_list():
    client, _ = make_client(FakeResponse(body=envelope(None)))
    assert await client.devices() == []


async def test_state_passes_params_and_returns_data():
    data = {
        "device": PLUG_ROW["device"],
        "model": "H5081",
        "properties": [{"online": True}, {"powerState": "on"}],
    }
    client, session = make_client(FakeResponse(body=envelope(data)))
    state = await client.state(PLUG_ROW["device"], "H5081")
    assert state == data
    call = session.calls[0]
    assert call["url"] == BASE_URL + "/devices/state"
    assert call["params"] == {"device": PLUG_ROW["device"], "model": "H5081"}


async def test_control_sends_turn_command():
    client, session = make_client(FakeResponse(body=envelope({})))
    await client.control(PLUG_ROW["device"], "H5081", "off")
    call = session.calls[0]
    assert call["method"] == "PUT"
    assert call["url"] == BASE_URL + "/devices/control"
    assert call["json"] == {
        "device": PLUG_ROW["device"],
        "model": "H5081",
        "cmd": {"name": "turn", "value": "off"},
    }


async def test_control_rejects_non_on_off_values_without_any_request():
    client, session = make_client()
    with pytest.raises(ValueError):
        await client.control(PLUG_ROW["device"], "H5081", "toggle")
    assert session.calls == []


# ── error mapping ────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", [401, 403])
async def test_auth_rejection_raises_auth_error(status: int):
    client, _ = make_client(FakeResponse(status=status, body={"message": "no"}))
    with pytest.raises(GoveeAuthError, match="GOVEE_API_KEY"):
        await client.devices()


async def test_rate_limit_carries_retry_after():
    client, _ = make_client(FakeResponse(status=429, headers={"Retry-After": "17"}))
    with pytest.raises(GoveeRateLimitError) as exc:
        await client.devices()
    assert exc.value.retry_after == 17.0


@pytest.mark.parametrize("headers", [{}, {"Retry-After": "soon"}])
async def test_rate_limit_without_usable_retry_after(headers: dict[str, str]):
    client, _ = make_client(FakeResponse(status=429, headers=headers))
    with pytest.raises(GoveeRateLimitError) as exc:
        await client.devices()
    assert exc.value.retry_after is None


async def test_http_error_carries_status_and_message():
    client, _ = make_client(FakeResponse(status=500, body={"message": "boom"}))
    with pytest.raises(GoveeHTTPError) as exc:
        await client.devices()
    assert exc.value.status == 500
    assert "boom" in str(exc.value)


async def test_http_error_with_non_json_body():
    client, _ = make_client(FakeResponse(status=502, json_exc=True))
    with pytest.raises(GoveeHTTPError) as exc:
        await client.devices()
    assert exc.value.status == 502


async def test_envelope_code_failure_raises_api_error():
    client, _ = make_client(
        FakeResponse(body={"code": 400, "message": "Unsupported Cmd Value"})
    )
    with pytest.raises(GoveeAPIError) as exc:
        await client.devices()
    assert exc.value.code == 400


async def test_status_200_non_json_body_raises_api_error():
    client, _ = make_client(FakeResponse(json_exc=True))
    with pytest.raises(GoveeAPIError):
        await client.devices()


async def test_closed_client_fails_loudly():
    client, session = make_client()
    await client.close()
    with pytest.raises(GoveeError, match="closed"):
        await client.devices()
    assert session.calls == []
