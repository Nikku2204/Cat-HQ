# SPDX-License-Identifier: GPL-3.0-or-later
"""Standalone Petlibro cloud API client — PLAF103 "Granary Smart Feeder" scope.

Ported from the PETLIBRO Home Assistant integration:
    https://github.com/jjjonesjr33/petlibro  (dev branch, v1.2.32)
    Copyright (C) 2024 flifloo
    Copyright (C) 2024-2026 jjjonesjr33 and contributors

Modified 2026-07-05 for Cat HQ (GPL-3.0 §5(a) notice): extracted the HTTP
client into a standalone aiohttp module with no Home Assistant dependency,
scoped to the PLAF103; hardened the envelope handling — re-login is
single-flight with a cooldown, the post-re-login retry re-checks the response
code (upstream returned it unchecked), and 0/null payloads are not coerced;
removed upstream's debug logging of tokens and credentials.

This file is licensed GPL-3.0-or-later — see LICENSE in this directory.
The rest of Cat HQ is not derived from the upstream integration.

Vendor-cloud etiquette (CLAUDE.md): Petlibro allows ONE active session per
account — every login invalidates the previous session (our login kicks the
phone app and vice versa). Therefore: logins are single-flight, rate-limited
by a cooldown, and NEVER retried in a loop.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

BASE_URL = "https://api.us.petlibro.com"  # only region upstream implements
APP_ID = 1
APP_SN = "c35772530d1041699c87fe62348507a8"
APP_VERSION = "1.3.45"  # mimicked app version; bump if the API starts rejecting

CODE_OK = 0
CODE_NOT_YET_LOGIN = 1009  # token expired OR session taken by another login

LOGIN_COOLDOWN_S = 60.0
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=30)

MAX_FEED_PORTIONS = 48  # upstream DEFAULT_MAX_FEED_PORTIONS; 1 portion ≈ 1/12 cup


class PetlibroError(Exception):
    """Base for all Petlibro client errors."""


class PetlibroHTTPError(PetlibroError):
    """Transport-level failure (HTTP status != 200)."""

    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(f"HTTP {status} from Petlibro API")


class PetlibroAPIError(PetlibroError):
    """API envelope failure (code != 0), or an unparseable response."""

    def __init__(self, code: int | None, msg: str | None) -> None:
        self.code = code
        self.msg = msg
        super().__init__(f"Petlibro API error code={code}: {msg}")


class PetlibroAuthError(PetlibroError):
    """The login endpoint rejected the credentials. Do not auto-retry."""


class PetlibroSessionError(PetlibroError):
    """Session lost and could not be safely re-established right now
    (login cooldown active, or NOT_YET_LOGIN persisted after a re-login —
    usually the phone app holding the account's single session)."""


class PetlibroClient:
    """Thin async client over the Petlibro cloud API (US region)."""

    def __init__(
        self,
        email: str,
        password: str,
        tz: str,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        self._email = email
        # The API wants a plain unsalted MD5 of the password. Hash once,
        # never keep or log the cleartext.
        self._password_md5 = hashlib.md5(password.encode("UTF-8")).hexdigest()
        self._tz = tz
        self._session = session
        self._owns_session = session is None
        self._token: str | None = None
        self._token_gen = 0  # bumped on every successful login (single-flight aid)
        self._login_lock = asyncio.Lock()
        self._last_login_at = float("-inf")  # time.monotonic() of last attempt
        self._closed = False

    # ── session/lifecycle ────────────────────────────────────────────────

    async def _ws(self) -> aiohttp.ClientSession:
        if self._closed:
            # never silently resurrect a session after close() — a late call
            # from a stopped adapter must fail loudly, not leak a session
            raise PetlibroError("client is closed")
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=REQUEST_TIMEOUT)
            self._owns_session = True
        return self._session

    async def close(self) -> None:
        self._closed = True
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None

    @property
    def logged_in(self) -> bool:
        return self._token is not None

    def _headers(self, *, with_token: bool = True) -> dict[str, str]:
        h = {
            "source": "ANDROID",
            "language": "EN",
            "timezone": self._tz,
            "version": APP_VERSION,
            "Content-Type": "application/json",
        }
        if with_token and self._token is not None:
            h["token"] = self._token  # header is literally "token", not Authorization
        return h

    # ── auth ─────────────────────────────────────────────────────────────

    async def login(self) -> None:
        """Log in (single-flight, cooldown-limited).

        Raises PetlibroAuthError on credential rejection,
        PetlibroSessionError when inside the cooldown window."""
        async with self._login_lock:
            await self._login_locked()

    async def _login_locked(self) -> None:
        now = time.monotonic()
        if now - self._last_login_at < LOGIN_COOLDOWN_S:
            raise PetlibroSessionError(
                "login attempted again within the cooldown — backing off so we "
                "don't ping-pong the account's single session (is the Petlibro "
                "phone app logged into this account?)"
            )
        self._last_login_at = now
        payload = {
            "appId": APP_ID,
            "appSn": APP_SN,
            "country": "US",
            "email": self._email,
            "password": self._password_md5,
            "phoneBrand": "",
            "phoneSystemVersion": "",
            "timezone": self._tz,
            "thirdId": None,
            "type": None,
        }
        data, code, msg = await self._raw(
            "/member/auth/login", payload, with_token=False
        )
        if code != CODE_OK:
            # Wrong password / unknown account / anything else: surfacing codes
            # verbatim — upstream never enumerates them (VERIFY-AT-BUILD).
            raise PetlibroAuthError(f"login rejected (code {code}): {msg}")
        token = (data or {}).get("token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise PetlibroAuthError("login returned code 0 but no token")
        self._token = token
        self._token_gen += 1
        logger.info("Petlibro login OK (token generation %d)", self._token_gen)

    async def _relogin(self, seen_gen: int) -> None:
        """Single-flight re-login: if another coroutine already refreshed the
        token while we waited on the lock, do nothing."""
        async with self._login_lock:
            if self._token_gen != seen_gen:
                return
            await self._login_locked()

    # ── request plumbing ─────────────────────────────────────────────────

    async def _raw(
        self, path: str, payload: dict | None, *, with_token: bool = True
    ) -> tuple[Any, int | None, str | None]:
        """One POST. Returns (data, code, msg) from the envelope."""
        ws = await self._ws()
        try:
            async with ws.post(
                BASE_URL + path,
                json=payload if payload is not None else {},
                headers=self._headers(with_token=with_token),
            ) as resp:
                if resp.status != 200:
                    raise PetlibroHTTPError(resp.status)
                try:
                    body = await resp.json()
                except Exception as err:
                    raise PetlibroAPIError(None, f"non-JSON response: {err}") from err
        except aiohttp.ClientError:
            raise  # transport errors surface as-is (adapter maps to degraded)
        if not isinstance(body, dict):
            raise PetlibroAPIError(None, f"unexpected envelope type {type(body).__name__}")
        return body.get("data"), body.get("code"), body.get("msg")

    async def _request(
        self, path: str, payload: dict | None = None, *, allow_relogin: bool = True
    ) -> Any:
        """POST with envelope handling and at most ONE re-login + retry.

        Returns the raw `data` member (may legitimately be 0, null, list...).
        """
        if self._token is None and allow_relogin:
            await self._relogin(self._token_gen)
        seen_gen = self._token_gen
        data, code, msg = await self._raw(path, payload)
        if code == CODE_OK:
            return data
        if code == CODE_NOT_YET_LOGIN and allow_relogin:
            await self._relogin(seen_gen)  # may raise Auth/SessionError
            data, code, msg = await self._raw(path, payload)
            if code == CODE_OK:
                return data
            if code == CODE_NOT_YET_LOGIN:
                raise PetlibroSessionError(
                    "NOT_YET_LOGIN persisted straight after a re-login — "
                    "the session is being contested by another client"
                )
        if code == CODE_NOT_YET_LOGIN:
            raise PetlibroSessionError("not logged in (and re-login not allowed here)")
        raise PetlibroAPIError(code, msg)

    @staticmethod
    def _serial_body(serial: str) -> dict[str, str]:
        # Upstream sends the serial under BOTH keys; keep that quirk.
        return {"id": serial, "deviceSn": serial}

    # ── API surface (PLAF103 scope) ──────────────────────────────────────

    async def device_list(self) -> list[dict]:
        return await self._request("/device/device/list", {}) or []

    async def base_info(self, serial: str) -> dict:
        return await self._request(
            "/device/device/baseInfo", self._serial_body(serial)
        ) or {}

    async def real_info(self, serial: str) -> dict:
        return await self._request(
            "/device/device/realInfo", self._serial_body(serial)
        ) or {}

    async def grain_status(self, serial: str) -> dict:
        return await self._request(
            "/device/data/grainStatus", self._serial_body(serial)
        ) or {}

    async def feeding_plans(self, serial: str) -> list[dict]:
        return await self._request(
            "/device/feedingPlan/list", self._serial_body(serial)
        ) or []

    async def feeding_plan_today(self, serial: str) -> dict:
        return await self._request(
            "/device/feedingPlan/todayNew", self._serial_body(serial)
        ) or {}

    async def work_records(
        self,
        serial: str,
        *,
        days: int = 7,
        size: int = 50,
        types: tuple[str, ...] = ("GRAIN_OUTPUT_SUCCESS",),
    ) -> list[dict]:
        now = datetime.now(timezone.utc)
        payload = {
            "deviceSn": serial,
            "startTime": int((now - timedelta(days=days)).timestamp() * 1000),
            "endTime": int(now.timestamp() * 1000),
            "size": size,
            "type": list(types),
        }
        return await self._request("/device/workRecord/list", payload) or []

    async def manual_feed(self, serial: str, portions: int) -> Any:
        """Dispense `portions` (1 portion ≈ 1/12 cup). Returns the raw `data`
        member (a bare int upstream; semantics undocumented — treat as opaque,
        `code == 0` is the success signal).

        Deliberately NO automatic re-login retry: if a feed request died
        mid-flight we must not risk dispensing twice. Caller retries manually.
        """
        portions = int(portions)
        if not 1 <= portions <= MAX_FEED_PORTIONS:
            raise ValueError(
                f"portions must be 1..{MAX_FEED_PORTIONS}, got {portions}"
            )
        payload = {
            "deviceSn": serial,  # no "id" key here — upstream quirk, keep it
            "grainNum": portions,
            "requestId": uuid.uuid4().hex,
        }
        return await self._request(
            "/device/device/manualFeeding", payload, allow_relogin=False
        )
