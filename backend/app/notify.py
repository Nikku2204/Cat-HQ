"""Owner alerts over WhatsApp via CallMeBot (M8 pulled forward, 2026-07-06).

Rules run every ~60s against the SAME signals the UI reads: in-memory adapter
state (zero extra vendor traffic) plus the local event log. Every send lands
in the M3 `notification_ledger`, and per-rule cooldowns make persisting
conditions remind — not spam (a full drawer nags twice a day, not once a
minute). A failed send retries, but never more than once per 10 minutes.

Transport is pluggable: `send_fn` is injected (tests use a spy; CallMeBot is
the default). CallMeBot etiquette for the free personal tier: text-only, to
the owner's own number, self-rate-limited (>=10s between sends).

The engine only starts when BOTH CALLMEBOT_* values are set — otherwise the
app runs exactly as before.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import aiohttp
from sqlalchemy import select

from .adapters.base import DeviceAdapter
from .models import Event, NotificationLedgerRow

logger = logging.getLogger("cathq.notify")

TICK_S = 60
MIN_SEND_GAP_S = 10  # free-gateway politeness
FAILED_RETRY_COOLDOWN = timedelta(minutes=10)

# LR4 mechanical faults (mirrors the frontend's LR_FAULT_CODES)
LR_FAULTS = {"CSF", "PD", "OTF", "BR"}
OFFLINE_GRACE_S = 10 * 60

# rule → hard cooldown between DELIVERED sends. Level conditions re-remind on
# this cadence while they persist; edge re-fires immediately once a condition
# clears and later re-occurs *after* the cooldown.
COOLDOWNS: dict[str, timedelta] = {
    "drawer_full": timedelta(hours=12),
    "lr_fault": timedelta(hours=6),
    "litter_low": timedelta(hours=24),
    "feeder_jam": timedelta(hours=6),
    "food_low": timedelta(hours=24),
    "offline_litterrobot": timedelta(hours=6),
    "offline_feeder": timedelta(hours=6),
    "no_cycle_24h": timedelta(hours=24),
    "no_feed_12h": timedelta(hours=12),
    "care_digest": timedelta(hours=20),
    "test": timedelta(seconds=0),
}

CARE_DIGEST_HOUR = 19  # local evening — same spirit as the in-app nudges

# "Bowl opens soon" heads-up (owner request 2026-07-07): one message per
# scheduled feed, this long before it. Deduped per feed OCCURRENCE (the feed's
# timestamp is the ledger token), and quiet-hours gated so the early-morning
# feeds never buzz the phone at 4am.
FEED_HEADS_UP = timedelta(minutes=60)
FEED_HEADS_UP_WAKING_HOURS = range(8, 22)  # local 08:00–21:59

SendFn = Callable[[str], Awaitable[bool]]


class Notifier:
    def __init__(
        self,
        adapters: dict[str, DeviceAdapter],
        session_factory: Any,
        settings: Any,
        send_fn: SendFn | None = None,
        time_fn: Callable[[], float] = time.monotonic,
        now_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self._adapters = adapters
        self._sf = session_factory
        self._settings = settings
        self._send_fn = send_fn or self._send_callmebot
        self._time = time_fn
        self._now = now_fn or (lambda: datetime.now(timezone.utc))
        try:
            self._tz = ZoneInfo(settings.tz or "UTC")
        except Exception:  # noqa: BLE001 — a bad TZ must not kill alerts
            self._tz = ZoneInfo("UTC")
        self._offline_since: dict[str, float] = {}
        self._last_send_mono: float = -MIN_SEND_GAP_S
        self._tasks: list[asyncio.Task[None]] = []

    # ── lifecycle (mirrors Recorder) ─────────────────────────────────────

    async def start(self) -> None:
        self._tasks = [asyncio.create_task(self._loop(), name="notifier")]
        logger.info("notifier started (WhatsApp via CallMeBot)")

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        self._tasks = []

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001 — the notifier must never die
                logger.exception("notifier tick failed")
            await asyncio.sleep(TICK_S * random.uniform(0.9, 1.15))

    # ── one evaluation pass ──────────────────────────────────────────────

    async def tick(self) -> None:
        for rule, device, text, token in await self._due_alerts():
            await self._maybe_send(rule, device, text, token)

    async def _due_alerts(self) -> list[tuple[str, str, str, str | None]]:
        """(rule, device, text, dedupe_token). Token rules fire once per
        token (e.g. per scheduled feed); token-less rules use cooldowns."""
        out: list[tuple[str, str, str, str | None]] = []
        out += [(r, d, t, None) for r, d, t in self._level_rules()]
        out += [(r, d, t, None) for r, d, t in await self._absence_rules()]
        digest = await self._care_digest()
        if digest:
            out.append((*digest, None))
        feed = self._feed_heads_up()
        if feed:
            out.append(feed)
        return out

    def _feed_heads_up(self) -> tuple[str, str, str, str] | None:
        feeder = self._attrs("feeder")
        if not feeder:
            return None
        raw = feeder.get("next_feed_time_utc")
        if not raw:
            return None
        try:
            feed_at = _parse_iso(str(raw))
        except ValueError:
            return None
        now = self._now()
        delta = feed_at - now
        if not (timedelta(0) < delta <= FEED_HEADS_UP):
            return None
        if now.astimezone(self._tz).hour not in FEED_HEADS_UP_WAKING_HOURS:
            return None  # never buzz the phone for the small-hours feeds
        mins = max(1, round(delta.total_seconds() / 60))
        local = feed_at.astimezone(self._tz).strftime("%-I:%M %p").lower()
        return (
            "feed_soon",
            "feeder",
            f"🍽️ Heads up — Chutku's bowl opens in ~{mins}m ({local}).",
            feed_at.isoformat(),
        )

    # ── level rules: read straight from in-memory adapter state ─────────

    def _attrs(self, device_id: str) -> dict[str, Any] | None:
        a = self._adapters.get(device_id)
        if a is None or not a.connected:
            return None
        attrs = getattr(a, "attributes", None)
        return dict(attrs) if isinstance(attrs, dict) else None

    def _level_rules(self) -> list[tuple[str, str, str]]:
        out: list[tuple[str, str, str]] = []
        litter = self._attrs("litterrobot")
        feeder = self._attrs("feeder")

        if litter:
            code = str(litter.get("status_code") or "")
            if code in LR_FAULTS:
                out.append(
                    ("lr_fault", "litterrobot",
                     f"⚠️ Litter box fault ({code}) — check Cat HQ.")
                )
            if litter.get("is_waste_drawer_full") is True:
                out.append(
                    ("drawer_full", "litterrobot",
                     "🗑️ The waste drawer is full — time to empty it.")
                )
            pct = litter.get("litter_level_pct")
            if isinstance(pct, (int, float)) and pct < 15:
                out.append(
                    ("litter_low", "litterrobot",
                     f"⏳ Litter is very low ({round(pct)}%) — top up soon.")
                )
        if feeder:
            if feeder.get("dispenser_blocked") is True:
                out.append(
                    ("feeder_jam", "feeder",
                     "⚠️ The food machine is jammed — Chutku disapproves.")
                )
            if feeder.get("food_low") is True:
                out.append(
                    ("food_low", "feeder",
                     "🍚 Food is running low — refill the machine soon.")
                )

        # offline needs to persist past a grace window before it alerts
        now_mono = self._time()
        for device_id, key, label in (
            ("litterrobot", "is_online", "litter box"),
            ("feeder", "online", "food machine"),
        ):
            attrs = self._attrs(device_id)
            is_off = attrs is not None and attrs.get(key) is False
            if is_off:
                since = self._offline_since.setdefault(device_id, now_mono)
                if now_mono - since >= OFFLINE_GRACE_S:
                    out.append(
                        (f"offline_{device_id}", device_id,
                         f"📶 The {label} has been offline for 10+ minutes.")
                    )
            else:
                self._offline_since.pop(device_id, None)
        return out

    # ── absence rules: read the event log ────────────────────────────────

    async def _newest_ts(self, *filters: Any) -> str | None:
        stmt = (
            select(Event.ts_utc)
            .where(*filters)
            .order_by(Event.ts_utc.desc())
            .limit(1)
        )
        async with self._sf() as session:
            return (await session.execute(stmt)).scalar_one_or_none()

    async def _oldest_ts(self) -> str | None:
        stmt = select(Event.ts_utc).order_by(Event.ts_utc.asc()).limit(1)
        async with self._sf() as session:
            return (await session.execute(stmt)).scalar_one_or_none()

    async def _absence_rules(self) -> list[tuple[str, str, str]]:
        """No clean cycle in 24h / no feed in 12h — but only once the DB has
        at least that much history (cold-start honesty: absence of data is
        not absence of cycles)."""
        out: list[tuple[str, str, str]] = []
        now = self._now()
        oldest = await self._oldest_ts()
        if oldest is None:
            return out
        history = now - _parse_iso(oldest)

        if history >= timedelta(hours=24):
            newest_cycle = await self._newest_cycle_ts()
            if newest_cycle is None or now - newest_cycle > timedelta(hours=24):
                out.append(
                    ("no_cycle_24h", "litterrobot",
                     "🚽 No clean cycle in the last 24 hours — worth a look.")
                )
        if history >= timedelta(hours=12):
            feed = await self._newest_ts(
                Event.device_id == "feeder", Event.event_type == "feed"
            )
            if feed is None or now - _parse_iso(feed) > timedelta(hours=12):
                out.append(
                    ("no_feed_12h", "feeder",
                     "🍽️ Nothing dispensed in the last 12 hours — worth a look.")
                )
        return out

    async def _newest_cycle_ts(self) -> datetime | None:
        """Newest completed clean cycle (status→CCC or 'Clean Cycle Complete'
        activity). Two small indexed queries; matching is done in Python since
        the discriminator lives inside the JSON payload."""
        stmt = (
            select(Event.ts_utc, Event.event_type, Event.data)
            .where(
                Event.device_id == "litterrobot",
                Event.event_type.in_(("status_change", "activity")),
            )
            .order_by(Event.ts_utc.desc())
            .limit(200)
        )
        async with self._sf() as session:
            rows = (await session.execute(stmt)).all()
        for ts, etype, data in rows:
            d = data or {}
            if etype == "status_change" and d.get("to") == "CCC":
                return _parse_iso(ts)
            if etype == "activity" and "clean cycle complete" in str(
                d.get("action", "")
            ).lower():
                return _parse_iso(ts)
        return None

    # ── care digest: the in-app evening nudges, once a day on WhatsApp ───

    async def _care_digest(self) -> tuple[str, str, str] | None:
        now_local = self._now().astimezone(self._tz)
        if now_local.hour < CARE_DIGEST_HOUR:
            return None
        day_start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_start = day_start_local.astimezone(timezone.utc)

        stmt = select(Event.ts_utc, Event.data).where(
            Event.device_id == "care", Event.event_type == "care"
        )
        async with self._sf() as session:
            rows = (await session.execute(stmt)).all()

        today: dict[str, int] = {}
        last: dict[str, datetime] = {}
        for ts, data in rows:
            task = str((data or {}).get("task", ""))
            t = _parse_iso(ts)
            if t >= day_start:
                today[task] = today.get(task, 0) + 1
            if task not in last or t > last[task]:
                last[task] = t

        due: list[str] = []
        if not today.get("brush"):
            due.append("brush his hair")
        if not today.get("play"):
            due.append("playtime")
        pets = today.get("pet", 0)
        if pets < 3:
            due.append(f"pets {pets}/3")
        now = self._now()
        if "nails" in last and now - last["nails"] > timedelta(days=30):
            due.append("nail trim")
        if "water" in last and now - last["water"] > timedelta(days=14):
            due.append("water filter")
        if not due:
            return None
        return ("care_digest", "care", "💛 Care reminders: " + " · ".join(due))

    # ── dedupe + send ────────────────────────────────────────────────────

    async def _maybe_send(
        self, rule: str, device: str, text: str, token: str | None = None
    ) -> None:
        if await self._suppressed(rule, token):
            return
        ok = await self._rate_limited_send(text)
        payload: dict[str, Any] = {"text": text, "channel": "whatsapp"}
        if token is not None:
            payload["token"] = token
        async with self._sf() as session:
            session.add(
                NotificationLedgerRow(
                    rule=rule,
                    device_id=device,
                    ts_utc=self._now().isoformat(),
                    payload=payload,
                    delivered=ok,
                )
            )
            await session.commit()
        (logger.info if ok else logger.warning)(
            "notify %s → %s: %s", rule, "sent" if ok else "FAILED", text
        )

    async def _suppressed(self, rule: str, token: str | None = None) -> bool:
        """Token rules: suppressed once a delivered send exists for that exact
        token (one message per occurrence, ever). Token-less rules: a delivered
        send within the rule's cooldown suppresses. Either way, ANY attempt
        (incl. failed) within the failed-retry window suppresses (no hammering).
        """
        stmt = (
            select(
                NotificationLedgerRow.ts_utc,
                NotificationLedgerRow.delivered,
                NotificationLedgerRow.payload,
            )
            .where(NotificationLedgerRow.rule == rule)
            .order_by(NotificationLedgerRow.ts_utc.desc())
            .limit(10)
        )
        async with self._sf() as session:
            rows = (await session.execute(stmt)).all()
        now = self._now()
        cooldown = COOLDOWNS.get(rule, timedelta(hours=12))
        for ts, delivered, payload in rows:
            age = now - _parse_iso(ts)
            if not delivered and age < FAILED_RETRY_COOLDOWN:
                return True
            if delivered:
                if token is not None:
                    if (payload or {}).get("token") == token:
                        return True
                elif age < cooldown:
                    return True
        return False

    async def _rate_limited_send(self, text: str) -> bool:
        gap = self._time() - self._last_send_mono
        if gap < MIN_SEND_GAP_S:
            await asyncio.sleep(MIN_SEND_GAP_S - gap)
        self._last_send_mono = self._time()
        try:
            return await self._send_fn(text)
        except Exception:  # noqa: BLE001
            logger.exception("send failed")
            return False

    async def _send_callmebot(self, text: str) -> bool:
        params = {
            "phone": self._settings.callmebot_phone,
            "text": text,
            "apikey": self._settings.callmebot_api_key,
        }
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                "https://api.callmebot.com/whatsapp.php", params=params
            ) as resp:
                body = await resp.text()
                if resp.status == 200:
                    return True
                logger.warning("CallMeBot %s: %s", resp.status, body[:200])
                return False

    # ── the /notify/test hook ────────────────────────────────────────────

    async def send_test(self) -> bool:
        ok = await self._rate_limited_send(
            "🐾 Test from Cat HQ — WhatsApp alerts are working!"
        )
        async with self._sf() as session:
            session.add(
                NotificationLedgerRow(
                    rule="test",
                    device_id="system",
                    ts_utc=self._now().isoformat(),
                    payload={"channel": "whatsapp"},
                    delivered=ok,
                )
            )
            await session.commit()
        return ok


def _parse_iso(ts: str) -> datetime:
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
