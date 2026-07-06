"""Govee smart-plug adapter (M5.5) — remote mains power control.

SAFETY MODEL (docs/05 Part A, non-negotiable — these plugs switch MAINS):
- Explicit binding, never guessing. The adapter is constructed with the
  exact deviceName from the Govee app (env GOVEE_PLUG_*). Discovery must
  match it exactly and unambiguously, or health goes ERROR (listing the
  account's device names) and every power command stays refused. There is
  no first-device fallback and no fuzzy match — switching the wrong mains
  socket (a fridge, an aquarium) must be impossible.
- Power commands are single-flight per plug: a second command while one
  runs gets PowerBusyError (mapped to 409), never a nested cycle.
- Power sequences run shielded from request cancellation: a phone dropping
  off wifi mid-cycle must never strand the plug OFF. The power_cycle ON
  step retries, and a final failure is LOUD (health ERROR + "failed" event)
  because it leaves the appliance unpowered.
- NOTHING in the backend calls execute() automatically (no fault →
  auto-cycle); the trigger is always a human. That discussion parks at M8+.
- Every power step is written to the event log (event_type "power") via the
  on_event hook that main.py installs.

Same shape as the other adapters: poll ~60s with jitter/backoff, fail
loudly into health(), start() never raises.
"""
from __future__ import annotations

import asyncio
import logging
import random
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any

import aiohttp

from ..base import AdapterHealth, Command, DeviceAdapter, DeviceState, HealthStatus
from .client import (
    GoveeAPIError,
    GoveeAuthError,
    GoveeClient,
    GoveeError,
    GoveeHTTPError,
    GoveeRateLimitError,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 60          # CLAUDE.md cadence — Govee limits are TIGHT
MAX_BACKOFF_S = 600
CONFIG_BACKOFF_CAP_S = 1800   # bad key / unresolved binding retry cap (30 min)
REQUEST_TIMEOUT_S = 45        # cap a single command/poll call
CONNECT_TIMEOUT_S = 100       # bind (1 req) + first poll (1 req)
ERROR_AFTER_FAILURES = 5
POWER_ON_ATTEMPTS = 3         # power_cycle must not quietly leave mains OFF
POWER_ON_RETRY_DELAY_S = 3

# Transient → DEGRADED + backoff. GoveeAuthError is handled separately (it
# means the key is bad — escalate like a credential failure, retry slowly).
TRANSIENT_ERRORS = (
    GoveeHTTPError,
    GoveeAPIError,
    GoveeRateLimitError,
    aiohttp.ClientError,
    TimeoutError,
)


class GoveeBindingError(GoveeError):
    """The configured plug name doesn't resolve to exactly one controllable
    device. Commands stay refused until it does (mains safety)."""


class PowerBusyError(Exception):
    """A power command is already running for this plug (→ HTTP 409)."""


class GoveePlugAdapter(DeviceAdapter):
    device_type = "plug"

    def __init__(
        self,
        device_id: str,
        plug_name: str,
        api_key: str = "",
        cycle_delay_s: float = 8.0,
        client: GoveeClient | None = None,
    ) -> None:
        self.device_id = device_id
        self._plug_name = plug_name.strip()
        self._client = client or GoveeClient(api_key)
        self._cycle_delay_s = float(cycle_delay_s)
        self._bound: dict[str, str] | None = None  # {"device","model"} once resolved
        self._static: dict[str, Any] = {}
        self._live: dict[str, Any] = {}
        self._device_online = True
        self.on_refresh: Any = None   # set by main.py: hub notifier (M4)
        self.on_event: Any = None     # set by main.py: async event-log writer
        self._power_lock = asyncio.Lock()
        self._poll_task: asyncio.Task[None] | None = None
        # health bookkeeping
        self._status = HealthStatus.UNCONFIGURED
        self._detail = "not started"
        self._last_state_refresh: datetime | None = None  # last good state poll
        self._last_cloud_success: datetime | None = None  # any successful call
        self._failures = 0
        self._config_failures = 0     # bad key or unresolved binding
        # Latched power-cycle failure: stays ERROR until the plug is OBSERVED
        # back ON (a routine poll success must not silently clear a stranded-
        # OFF appliance). None = no outstanding power fault.
        self._power_fault: str | None = None

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Bind the configured plug and start polling. NEVER raises — every
        failure lands in health() and the loop keeps retrying (slowly for
        config-class failures: bad key, name not found)."""
        self._status, self._detail = HealthStatus.DEGRADED, "connecting"
        try:
            await self._connect_and_poll()
            self._mark_poll_success("connected")
        except asyncio.CancelledError:
            raise
        except GoveeAuthError as err:
            self._config_failures = 1
            self._set_error(str(err))
            logger.error("Govee API key rejected; will retry slowly: %s", err)
        except GoveeBindingError as err:
            self._config_failures = 1
            self._set_error(str(err))
            logger.error("Govee plug binding failed; will retry slowly: %s", err)
        except Exception as err:  # noqa: BLE001 — startup must survive anything
            self._mark_failure(f"initial connect failed: {err}")
            logger.warning("Govee initial connect failed, will retry: %s", err)
        self._poll_task = asyncio.create_task(
            self._poll_loop(), name=f"{self.device_id}-poll"
        )

    async def stop(self) -> None:
        if self._poll_task is not None:
            self._poll_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._poll_task
            self._poll_task = None
        # Let an in-flight (shielded) power sequence finish before closing the
        # client — shutting down mid-cycle must not strand the plug OFF. The
        # budget must cover the WHOLE worst-case cycle: OFF + delay + every ON
        # attempt and retry gap. (Normally the lock is free and this returns
        # instantly.) docker-compose sets a matching stop_grace_period so a
        # graceful stop isn't preempted by SIGKILL; if it is anyway, a client
        # closed mid-cycle now fails LOUD (see _power_cycle catch-all).
        budget = (
            REQUEST_TIMEOUT_S
            + self._cycle_delay_s
            + POWER_ON_ATTEMPTS * (REQUEST_TIMEOUT_S + POWER_ON_RETRY_DELAY_S)
            + 5
        )
        with suppress(TimeoutError):
            async with asyncio.timeout(budget):
                async with self._power_lock:
                    pass
        await self._client.close()

    async def _connect_and_poll(self) -> None:
        """Resolve the binding if needed, then one state poll."""
        async with asyncio.timeout(CONNECT_TIMEOUT_S):
            if self._bound is None:
                await self._bind()
            await self._poll_once()

    async def _bind(self) -> None:
        """Resolve the configured deviceName against account discovery.
        Exact, unambiguous, controllable — or GoveeBindingError."""
        devices = await self._client.devices()
        matches = [
            d for d in devices
            if str(d.get("deviceName", "")).strip() == self._plug_name
        ]
        if not matches:
            names = ", ".join(
                repr(str(d.get("deviceName", "?"))) for d in devices
            ) or "none"
            raise GoveeBindingError(
                f"plug name {self._plug_name!r} not found; "
                f"devices on account: {names}"
            )
        if len(matches) > 1:
            raise GoveeBindingError(
                f"plug name {self._plug_name!r} matches {len(matches)} devices — "
                "rename them uniquely in the Govee app"
            )
        chosen = matches[0]
        supports_turn = "turn" in (chosen.get("supportCmds") or [])
        if not chosen.get("controllable", False) or not supports_turn:
            raise GoveeBindingError(
                f"device {self._plug_name!r} (model {chosen.get('model')}) does "
                "not support on/off control — refusing to bind"
            )
        self._bound = {"device": chosen["device"], "model": chosen["model"]}
        self._static = {
            "name": chosen.get("deviceName"),
            "model": chosen.get("model"),
            "govee_device_id": chosen.get("device"),
            "bound_to": self.device_id.removeprefix("plug_"),
        }
        logger.info(
            "govee plug bound: %s → %r (model %s)",
            self.device_id, self._plug_name, chosen.get("model"),
        )

    async def _poll_once(self) -> None:
        """One state fetch. Raises on any API/transport failure."""
        assert self._bound is not None
        state = await self._client.state(
            self._bound["device"], self._bound["model"]
        )
        props: dict[str, Any] = {}
        for entry in state.get("properties") or []:
            if isinstance(entry, dict):
                props.update(entry)
        online = props.get("online", True)
        if not isinstance(online, bool):
            # the v1 API is known to return "false"/"true" strings here
            online = str(online).strip().lower() == "true"
        self._device_online = online
        self._live = {
            **self._static,
            "online": online,
            "power_on": str(props.get("powerState", "")).lower() == "on",
        }

    async def _poll_loop(self) -> None:
        delay: float = POLL_INTERVAL_S
        while True:
            await asyncio.sleep(delay * random.uniform(0.9, 1.1))
            try:
                await self._connect_and_poll()
                self._mark_poll_success("polled")
                delay = POLL_INTERVAL_S
            except asyncio.CancelledError:
                raise
            except (GoveeAuthError, GoveeBindingError) as err:
                # Config-class failure: keep retrying slowly (the owner may
                # fix the key or rename the plug in the Govee app), stay ERROR.
                self._config_failures += 1
                self._set_error(f"{err} ({self._config_failures}x)")
                delay = min(
                    POLL_INTERVAL_S * 2 ** self._config_failures,
                    CONFIG_BACKOFF_CAP_S,
                )
                logger.error(
                    "Govee config failure #%d, next attempt ~%ds: %s",
                    self._config_failures, int(delay), err,
                )
            except GoveeRateLimitError as err:
                self._mark_failure(f"rate limited: {err}")
                delay = min(max(err.retry_after or 0, delay * 2), MAX_BACKOFF_S)
                logger.warning("Govee rate limited, next poll ~%ds", int(delay))
            except TRANSIENT_ERRORS as err:
                self._mark_failure(f"poll failed: {err}")
                delay = min(delay * 2, MAX_BACKOFF_S)
                logger.warning(
                    "Govee poll failed (%d in a row, next try ~%ds): %s",
                    self._failures, int(delay), err,
                )
            except Exception as err:  # noqa: BLE001 — unexpected: loud, retry slowly
                self._set_error(f"unexpected error: {err!r}")
                delay = MAX_BACKOFF_S
                logger.exception("unexpected error in %s poll loop", self.device_id)

    # ── DeviceAdapter interface ──────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return (
            self._bound is not None
            and bool(self._live)
            and self._last_state_refresh is not None
        )

    async def get_state(self) -> DeviceState:
        """fetched_at_utc is the time of the last successful STATE poll —
        never fabricated from the request time. (Power commands update
        power_on optimistically; the poll reconciles.)"""
        if not self.connected:
            raise RuntimeError(f"{self.device_id} adapter is not connected")
        return DeviceState(
            device_id=self.device_id,
            device_type=self.device_type,
            fetched_at_utc=self._last_state_refresh,
            attributes=dict(self._live),
        )

    async def execute(self, command: Command) -> dict[str, Any]:
        if self._bound is None:
            # Binding guard (docs/05): an unbound plug must never switch.
            raise RuntimeError(
                f"{self.device_id} has no bound plug — refusing power command"
            )
        if command.name == "power_on":
            runner = self._power(True)
        elif command.name == "power_off":
            runner = self._power(False)
        elif command.name == "power_cycle":
            runner = self._power_cycle()
        else:
            raise ValueError(f"unknown command for plug: {command.name!r}")
        # Shield the sequence from request cancellation: if the phone drops
        # off wifi mid-cycle, the OFF→ON sequence still runs to completion.
        task = asyncio.create_task(runner, name=f"{self.device_id}-{command.name}")
        task.add_done_callback(_retrieve_task_result)
        return await asyncio.shield(task)

    async def health(self) -> AdapterHealth:
        status = self._status
        detail = self._detail
        if self._power_fault:
            # a latched stranded-OFF failure outranks everything else
            return AdapterHealth(
                status=HealthStatus.ERROR,
                detail=self._power_fault,
                last_success_utc=self._last_cloud_success,
                consecutive_failures=self._failures,
            )
        if status is HealthStatus.DEGRADED and self._failures >= ERROR_AFTER_FAILURES:
            status = HealthStatus.ERROR
        if status is HealthStatus.OK and not self._device_online:
            # Cloud reachable but the plug itself is unreachable/off-wifi.
            status = HealthStatus.DEGRADED
            detail = "plug reports offline (check plug power/wifi)"
        return AdapterHealth(
            status=status,
            detail=detail,
            last_success_utc=self._last_cloud_success,
            consecutive_failures=self._failures,
        )

    # ── power sequences (single-flight, event-logged) ────────────────────

    def _check_not_busy(self) -> None:
        # locked() → raise has no await before the acquire that follows in
        # the caller, so two tasks can't both slip past (single event loop).
        if self._power_lock.locked():
            raise PowerBusyError(
                f"a power command is already running for {self.device_id}"
            )

    async def _power(self, on: bool) -> dict[str, Any]:
        self._check_not_busy()
        async with self._power_lock:
            assert self._bound is not None
            value = "on" if on else "off"
            command = f"power_{value}"
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    await self._client.control(
                        self._bound["device"], self._bound["model"], value
                    )
            # Catch EVERYTHING (not just TRANSIENT_ERRORS): a GoveeAuthError,
            # a "client is closed" GoveeError from a concurrent stop(), or an
            # unexpected error must still fail LOUD, never silently. A bare
            # on/off doesn't strand the appliance, but the failure still has
            # to reach the badge and the event log. (CancelledError is a
            # BaseException — not caught here — so shielding is preserved.)
            except Exception as err:  # noqa: BLE001 — mains action fails loud
                self._mark_failure(f"{command} failed: {err}")
                await self._emit_power(
                    {"command": command, "step": "failed", "error": str(err)}
                )
                raise
            self._apply_power_locally(on)
            await self._emit_power({"command": command, "step": "done"})
            return {"command": command, "accepted": True}

    async def _power_cycle(self) -> dict[str, Any]:
        self._check_not_busy()
        async with self._power_lock:
            assert self._bound is not None
            device, model = self._bound["device"], self._bound["model"]
            try:
                async with asyncio.timeout(REQUEST_TIMEOUT_S):
                    await self._client.control(device, model, "off")
            # Catch-all (see _power): the OFF step failing means the plug never
            # switched — less dangerous, but still fails loud + mapped.
            except Exception as err:  # noqa: BLE001 — mains action fails loud
                self._mark_failure(f"power_cycle off step failed: {err}")
                await self._emit_power({
                    "command": "power_cycle", "step": "failed",
                    "during": "off", "error": str(err),
                })
                raise
            self._apply_power_locally(False)
            await self._emit_power({
                "command": "power_cycle", "step": "off",
                "delay_s": self._cycle_delay_s,
            })
            await asyncio.sleep(self._cycle_delay_s)
            # The ON step MUST NOT fail quietly — a failure here leaves the
            # appliance without mains. Retry transient errors; a non-transient
            # error (bad key, closed client) won't self-heal, so stop retrying
            # and fall straight through to the LOUD failure. Either way the
            # loud block below runs — no error type can skip it.
            last_err: Exception | None = None
            for attempt in range(1, POWER_ON_ATTEMPTS + 1):
                try:
                    async with asyncio.timeout(REQUEST_TIMEOUT_S):
                        await self._client.control(device, model, "on")
                    last_err = None
                    break
                except Exception as err:  # noqa: BLE001 — never strand OFF silently
                    last_err = err
                    transient = isinstance(err, TRANSIENT_ERRORS)
                    logger.warning(
                        "power_cycle ON attempt %d/%d failed for %s (%s): %s",
                        attempt, POWER_ON_ATTEMPTS, self.device_id,
                        "transient" if transient else "non-transient", err,
                    )
                    if transient and attempt < POWER_ON_ATTEMPTS:
                        await asyncio.sleep(self._on_retry_delay(err))
                    else:
                        break  # non-transient: retrying won't help — fail now
            if last_err is not None:
                # Latch it: a routine poll success must NOT clear this while the
                # plug may still be OFF (only an observed power_on=True does).
                self._power_fault = (
                    f"POWER CYCLE FAILED — plug may still be OFF: {last_err}"
                )
                self._set_error(self._power_fault)
                await self._emit_power({
                    "command": "power_cycle", "step": "failed",
                    "during": "on", "error": str(last_err),
                })
                raise last_err
            self._apply_power_locally(True)
            await self._emit_power({"command": "power_cycle", "step": "on"})
            return {
                "command": "power_cycle",
                "accepted": True,
                "off_seconds": self._cycle_delay_s,
            }

    def _apply_power_locally(self, on: bool) -> None:
        """Optimistic update: v1 state lags control by seconds, so reflect
        the accepted command immediately and let the 60s poll reconcile."""
        if self._live:
            self._live["power_on"] = on
        if on and self._power_fault is not None:
            # the plug is back ON via an accepted command → the stranded-OFF
            # emergency is resolved. Clear the latch AND recover health out of
            # ERROR (the next poll reconfirms); a normal on/off with no
            # outstanding fault leaves health untouched (command success does
            # not vouch for state freshness — see _note_cloud_success).
            self._power_fault = None
            self._status = HealthStatus.OK
            self._detail = "plug switched on"
        self._note_cloud_success()
        self._notify()

    @staticmethod
    def _on_retry_delay(err: Exception) -> float:
        """Back-off before the next ON attempt. Honor a rate-limit Retry-After
        (capped) so we don't burn all three attempts inside one 429 window."""
        if isinstance(err, GoveeRateLimitError) and err.retry_after:
            return min(err.retry_after, REQUEST_TIMEOUT_S)
        return POWER_ON_RETRY_DELAY_S

    async def _emit_power(self, data: dict[str, Any]) -> None:
        """Best-effort event-log write via the main.py hook — a DB hiccup
        must never abort a mains power sequence."""
        if self.on_event is None:
            return
        try:
            await self.on_event(data)
        except Exception:  # noqa: BLE001 — logging must not break the sequence
            logger.exception("power event hook failed (data: %s)", data)

    # ── health bookkeeping ───────────────────────────────────────────────

    def _mark_poll_success(self, detail: str) -> None:
        """A successful STATE poll — flips health OK UNLESS a power-cycle
        failure is latched and the plug is still not observed ON."""
        now = datetime.now(timezone.utc)
        self._last_state_refresh = now
        self._last_cloud_success = now
        self._failures = 0
        self._config_failures = 0
        if self._power_fault and self._live.get("power_on") is True:
            # the plug came back (owner flipped it, or a later command) — clear
            self._power_fault = None
        if self._power_fault:
            # still stranded: a healthy poll must not paint over the failure
            self._status, self._detail = HealthStatus.ERROR, self._power_fault
        else:
            self._status, self._detail = HealthStatus.OK, detail
        self._notify()

    def _note_cloud_success(self) -> None:
        """A successful command call: proves connectivity, does NOT vouch
        for state freshness — health status/counters untouched."""
        self._last_cloud_success = datetime.now(timezone.utc)

    def _mark_failure(self, detail: str) -> None:
        self._failures += 1
        self._status, self._detail = HealthStatus.DEGRADED, detail
        self._notify()

    def _set_error(self, detail: str) -> None:
        self._status, self._detail = HealthStatus.ERROR, detail
        self._notify()

    def _notify(self) -> None:
        """Fan a refresh/health change out to the WebSocket hub (M4)."""
        if self.on_refresh is not None:
            try:
                self.on_refresh()
            except Exception:  # noqa: BLE001 — notification must never break polling
                logger.exception("%s on_refresh hook failed", self.device_id)


def _retrieve_task_result(task: asyncio.Task) -> None:
    """Shielded power tasks may outlive their request; retrieve the result so
    a post-disconnect failure is logged instead of 'exception never retrieved'."""
    if task.cancelled():
        return
    err = task.exception()
    if err is not None:
        logger.debug("power task %s finished with: %s", task.get_name(), err)
