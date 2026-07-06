"""Govee developer API v1 client — smart-plug scope (M5.5, docs/05).

v1 REST (developer-api.govee.com) is the older API but is known to support
the H5081/H5083 plug family. The newer "Platform API" (openapi.api.govee.com)
is deliberately NOT used unless v1 rejects the plugs — all HTTP lives in this
file so that swap stays cheap (docs/05 Part A).

Vendor-cloud etiquette (CLAUDE.md): rate limits are tight (~10 req/min per
device plus daily caps). Callers poll at 60s with jitter and exponential
backoff and never tight-loop; a 429 surfaces as GoveeRateLimitError with the
server's Retry-After when present.

The API key is sent only as the Govee-API-Key header and is never logged.
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

BASE_URL = "https://developer-api.govee.com/v1"
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)


class GoveeError(Exception):
    """Base for all Govee client errors."""


class GoveeHTTPError(GoveeError):
    """Transport-level failure (HTTP status not 200/401/403/429)."""

    def __init__(self, status: int, message: str | None = None) -> None:
        self.status = status
        self.message = message
        detail = f": {message}" if message else ""
        super().__init__(f"HTTP {status} from Govee API{detail}")


class GoveeAPIError(GoveeError):
    """Envelope failure (code != 200) or an unparseable response body."""

    def __init__(self, code: int | None, msg: str | None) -> None:
        self.code = code
        self.msg = msg
        super().__init__(f"Govee API error code={code}: {msg}")


class GoveeAuthError(GoveeError):
    """The API key was rejected (HTTP 401/403). Check GOVEE_API_KEY."""


class GoveeRateLimitError(GoveeError):
    """HTTP 429 — v1 limits are ~10 req/min/device plus daily caps."""

    def __init__(self, retry_after: float | None = None) -> None:
        self.retry_after = retry_after
        suffix = f" (retry after ~{retry_after:.0f}s)" if retry_after else ""
        super().__init__(f"Govee API rate limit hit{suffix}")


class GoveeClient:
    """Thin async client over the Govee developer API v1."""

    def __init__(
        self, api_key: str, session: aiohttp.ClientSession | None = None
    ) -> None:
        self._api_key = api_key
        self._session = session
        self._owns_session = session is None
        self._closed = False

    # ── session/lifecycle ────────────────────────────────────────────────

    async def _ws(self) -> aiohttp.ClientSession:
        if self._closed:
            # never silently resurrect a session after close() — a late call
            # from a stopped adapter must fail loudly, not leak a session
            raise GoveeError("client is closed")
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=REQUEST_TIMEOUT)
            self._owns_session = True
        return self._session

    async def close(self) -> None:
        self._closed = True
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None

    # ── request plumbing ─────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        """One request. Returns the envelope's `data` member.

        Transport errors (aiohttp.ClientError, TimeoutError) surface as-is —
        the adapter maps them to DEGRADED like every other vendor cloud.
        """
        ws = await self._ws()
        headers = {"Govee-API-Key": self._api_key}
        async with ws.request(
            method, BASE_URL + path, params=params, json=json, headers=headers
        ) as resp:
            try:
                body = await resp.json(content_type=None)
            except Exception:  # noqa: BLE001 — error pages are often non-JSON
                body = None
            message = body.get("message") if isinstance(body, dict) else None
            if resp.status in (401, 403):
                raise GoveeAuthError(
                    f"API key rejected (HTTP {resp.status}) — check GOVEE_API_KEY"
                )
            if resp.status == 429:
                retry_raw = resp.headers.get("Retry-After")
                try:
                    retry_after = float(retry_raw) if retry_raw else None
                except ValueError:
                    retry_after = None
                raise GoveeRateLimitError(retry_after)
            if resp.status != 200:
                raise GoveeHTTPError(resp.status, message)
            if not isinstance(body, dict):
                raise GoveeAPIError(None, "non-JSON or unexpected response body")
            code = body.get("code")
            if code is not None and code != 200:
                raise GoveeAPIError(code, message)
            return body.get("data")

    # ── API surface (docs/05: verify against the live API at first boot) ──

    async def devices(self) -> list[dict[str, Any]]:
        """All devices on the account: device (MAC-ish id), model,
        deviceName, controllable, retrievable, supportCmds."""
        data = await self._request("GET", "/devices")
        devices = data.get("devices") if isinstance(data, dict) else None
        return devices or []

    async def state(self, device: str, model: str) -> dict[str, Any]:
        """Current state; `properties` is a list of single-key dicts,
        e.g. [{"online": true}, {"powerState": "on"}]."""
        data = await self._request(
            "GET", "/devices/state", params={"device": device, "model": model}
        )
        return data if isinstance(data, dict) else {}

    async def control(self, device: str, model: str, value: str) -> None:
        """Switch the plug. `value` is "on" or "off" — nothing else exists
        for plugs, and nothing else may be sent (mains safety, docs/05)."""
        if value not in ("on", "off"):
            raise ValueError(f'plug control value must be "on" or "off", got {value!r}')
        await self._request(
            "PUT",
            "/devices/control",
            json={
                "device": device,
                "model": model,
                "cmd": {"name": "turn", "value": value},
            },
        )
