"""Govee plug adapter unit tests (M5.5, docs/05 Part A).

HARD RULES (docs/04): no vendor clouds (client mocked below), no hardware.
The mains-safety contract is what these tests exist to protect:
explicit binding, refusal when unbound/ambiguous, single-flight power
commands, loud failure when a cycle strands the plug OFF, and the full
event trail for every switch.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import app.adapters.govee.adapter as govee_adapter
from app.adapters.base import Command, HealthStatus
from app.adapters.govee import (
    GoveeAuthError,
    GoveeError,
    GoveeHTTPError,
    GoveePlugAdapter,
    GoveeRateLimitError,
    PowerBusyError,
)

PLUG_ROW = {
    "device": "AA:BB:CC:DD:EE:FF:11:22",
    "model": "H5081",
    "deviceName": "litter robot plug",
    "controllable": True,
    "retrievable": True,
    "supportCmds": ["turn"],
}


class FakeGoveeClient:
    """Scriptable stand-in for GoveeClient (client boundary per docs/04)."""

    def __init__(self) -> None:
        self.device_rows: list[dict[str, Any]] = [dict(PLUG_ROW)]
        self.devices_exc: BaseException | None = None
        self.state_props: list[dict[str, Any]] = [
            {"online": True},
            {"powerState": "off"},
        ]
        self.state_exc: BaseException | None = None
        self.control_calls: list[tuple[str, str, str]] = []
        self.control_exc: dict[str, BaseException] = {}  # value → raise
        self.closed = False

    async def devices(self) -> list[dict[str, Any]]:
        if self.devices_exc is not None:
            raise self.devices_exc
        return [dict(r) for r in self.device_rows]

    async def state(self, device: str, model: str) -> dict[str, Any]:
        if self.state_exc is not None:
            raise self.state_exc
        return {"device": device, "model": model, "properties": list(self.state_props)}

    async def control(self, device: str, model: str, value: str) -> None:
        self.control_calls.append((device, model, value))
        exc = self.control_exc.get(value)
        if exc is not None:
            raise exc

    async def close(self) -> None:
        self.closed = True


def make_adapter(
    fake: FakeGoveeClient | None = None,
    plug_name: str = "litter robot plug",
    cycle_delay_s: float = 0.01,
) -> tuple[GoveePlugAdapter, FakeGoveeClient, list[dict[str, Any]]]:
    fake = fake or FakeGoveeClient()
    adapter = GoveePlugAdapter(
        device_id="plug_litterrobot",
        plug_name=plug_name,
        cycle_delay_s=cycle_delay_s,
        client=fake,  # type: ignore[arg-type]
    )
    events: list[dict[str, Any]] = []

    async def on_event(data: dict[str, Any]) -> None:
        events.append(data)

    adapter.on_event = on_event
    return adapter, fake, events


# ── binding (the mains-safety core) ──────────────────────────────────────


async def test_bind_and_first_poll():
    adapter, _, _ = make_adapter()
    await adapter.start()
    try:
        assert adapter.connected
        health = await adapter.health()
        assert health.status is HealthStatus.OK
        state = await adapter.get_state()
        assert state.device_type == "plug"
        assert state.attributes["power_on"] is False
        assert state.attributes["online"] is True
        assert state.attributes["model"] == "H5081"
    finally:
        await adapter.stop()
    assert adapter._client.closed  # type: ignore[attr-defined]


async def test_unknown_name_goes_error_and_lists_account_devices():
    adapter, _, _ = make_adapter(plug_name="no such plug")
    await adapter.start()
    try:
        assert not adapter.connected
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR
        assert "not found" in health.detail
        assert "litter robot plug" in health.detail  # owner sees what exists
    finally:
        await adapter.stop()


async def test_ambiguous_name_refuses_to_bind():
    fake = FakeGoveeClient()
    fake.device_rows = [dict(PLUG_ROW), dict(PLUG_ROW, device="11:22")]
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        assert not adapter.connected
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR
        assert "matches 2 devices" in health.detail
    finally:
        await adapter.stop()


@pytest.mark.parametrize(
    "override", [{"controllable": False}, {"supportCmds": ["brightness"]}]
)
async def test_uncontrollable_device_refuses_to_bind(override: dict[str, Any]):
    fake = FakeGoveeClient()
    fake.device_rows = [dict(PLUG_ROW, **override)]
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR
        assert "refusing to bind" in health.detail
    finally:
        await adapter.stop()


async def test_rejected_api_key_goes_error():
    fake = FakeGoveeClient()
    fake.devices_exc = GoveeAuthError("API key rejected — check GOVEE_API_KEY")
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR
        assert "GOVEE_API_KEY" in health.detail
    finally:
        await adapter.stop()


async def test_binding_recovers_once_name_appears():
    fake = FakeGoveeClient()
    fake.device_rows = []
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        assert not adapter.connected
        fake.device_rows = [dict(PLUG_ROW)]  # owner fixed the Govee account
        await adapter._connect_and_poll()  # what the poll loop retries
        adapter._mark_poll_success("polled")
        assert adapter.connected
        assert (await adapter.health()).status is HealthStatus.OK
    finally:
        await adapter.stop()


async def test_execute_refused_while_unbound():
    adapter, fake, _ = make_adapter(plug_name="no such plug")
    await adapter.start()
    try:
        with pytest.raises(RuntimeError, match="refusing power command"):
            await adapter.execute(Command(name="power_on"))
        assert fake.control_calls == []  # nothing was ever switched
    finally:
        await adapter.stop()


# ── state parsing ────────────────────────────────────────────────────────


async def test_offline_plug_degrades_health():
    fake = FakeGoveeClient()
    fake.state_props = [{"online": False}, {"powerState": "off"}]
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        health = await adapter.health()
        assert health.status is HealthStatus.DEGRADED
        assert "offline" in health.detail
    finally:
        await adapter.stop()


async def test_stringly_typed_online_is_normalized():
    fake = FakeGoveeClient()
    fake.state_props = [{"online": "false"}, {"powerState": "on"}]
    adapter, _, _ = make_adapter(fake)
    await adapter.start()
    try:
        state = await adapter.get_state()
        assert state.attributes["online"] is False
        assert state.attributes["power_on"] is True
    finally:
        await adapter.stop()


# ── power commands ───────────────────────────────────────────────────────


async def test_power_on_and_off(monkeypatch):
    adapter, fake, events = make_adapter()
    await adapter.start()
    try:
        result = await adapter.execute(Command(name="power_on"))
        assert result == {"command": "power_on", "accepted": True}
        assert fake.control_calls == [(PLUG_ROW["device"], "H5081", "on")]
        assert (await adapter.get_state()).attributes["power_on"] is True  # optimistic
        result = await adapter.execute(Command(name="power_off"))
        assert result["command"] == "power_off"
        assert (await adapter.get_state()).attributes["power_on"] is False
        assert events == [
            {"command": "power_on", "step": "done"},
            {"command": "power_off", "step": "done"},
        ]
    finally:
        await adapter.stop()


async def test_power_cycle_sequence_and_event_trail():
    adapter, fake, events = make_adapter()
    await adapter.start()
    try:
        result = await adapter.execute(Command(name="power_cycle"))
        assert result["accepted"] is True
        values = [call[2] for call in fake.control_calls]
        assert values == ["off", "on"]
        assert [e["step"] for e in events] == ["off", "on"]
        assert events[0]["command"] == "power_cycle"
        assert events[0]["delay_s"] == 0.01
        assert (await adapter.get_state()).attributes["power_on"] is True
    finally:
        await adapter.stop()


async def test_unknown_command_rejected():
    adapter, fake, _ = make_adapter()
    await adapter.start()
    try:
        with pytest.raises(ValueError, match="unknown command"):
            await adapter.execute(Command(name="start_clean"))
        assert fake.control_calls == []
    finally:
        await adapter.stop()


async def test_second_power_command_gets_busy_error():
    adapter, fake, _ = make_adapter(cycle_delay_s=0.2)
    await adapter.start()
    try:
        cycle = asyncio.create_task(adapter.execute(Command(name="power_cycle")))
        await asyncio.sleep(0.05)  # cycle is inside its OFF window
        with pytest.raises(PowerBusyError):
            await adapter.execute(Command(name="power_on"))
        result = await cycle
        assert result["accepted"] is True
        assert [call[2] for call in fake.control_calls] == ["off", "on"]  # no nesting
    finally:
        await adapter.stop()


async def test_cancelled_request_never_strands_the_plug_off():
    """A phone dropping off wifi mid-cycle cancels the request task; the
    shielded sequence must still switch the plug back ON."""
    adapter, fake, events = make_adapter(cycle_delay_s=0.2)
    await adapter.start()
    try:
        request = asyncio.create_task(adapter.execute(Command(name="power_cycle")))
        await asyncio.sleep(0.05)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        async with asyncio.timeout(2):
            while [call[2] for call in fake.control_calls] != ["off", "on"]:
                await asyncio.sleep(0.01)
        assert [e["step"] for e in events] == ["off", "on"]
    finally:
        await adapter.stop()


async def test_cycle_on_failure_is_loud(monkeypatch):
    monkeypatch.setattr(govee_adapter, "POWER_ON_RETRY_DELAY_S", 0.01)
    adapter, fake, events = make_adapter()
    await adapter.start()
    try:
        fake.control_exc["on"] = GoveeHTTPError(500, "boom")
        with pytest.raises(GoveeHTTPError):
            await adapter.execute(Command(name="power_cycle"))
        values = [call[2] for call in fake.control_calls]
        assert values == ["off", "on", "on", "on"]  # all retries spent
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR
        assert "POWER CYCLE FAILED" in health.detail
        assert events[-1]["step"] == "failed"
        assert events[-1]["during"] == "on"
    finally:
        await adapter.stop()


async def test_cycle_on_NON_transient_error_is_still_loud():
    """The critical case (adversarial review): a GoveeAuthError or a
    'client is closed' GoveeError on the ON step is NOT in TRANSIENT_ERRORS,
    yet must still hit the loud-failure path — never silently strand OFF.
    Non-transient errors don't self-heal, so retries are skipped."""
    for exc in (GoveeAuthError("key revoked"), GoveeError("client is closed")):
        adapter, fake, events = make_adapter()
        await adapter.start()
        try:
            fake.control_exc["on"] = exc
            with pytest.raises((GoveeAuthError, GoveeError)):
                await adapter.execute(Command(name="power_cycle"))
            values = [call[2] for call in fake.control_calls]
            assert values == ["off", "on"]  # no wasted retries on a dead key
            health = await adapter.health()
            assert health.status is HealthStatus.ERROR
            assert "POWER CYCLE FAILED" in health.detail
            assert events[-1] == {
                "command": "power_cycle", "step": "failed",
                "during": "on", "error": str(exc),
            }
        finally:
            await adapter.stop()


async def test_latched_failure_survives_a_routine_poll_while_plug_still_off(monkeypatch):
    monkeypatch.setattr(govee_adapter, "POWER_ON_RETRY_DELAY_S", 0.01)
    """A power-cycle failure must stay ERROR across the next poll if the plug
    is still OFF — a healthy poll must not paint over a stranded appliance."""
    adapter, fake, _ = make_adapter()
    await adapter.start()
    try:
        fake.control_exc["on"] = GoveeHTTPError(500, "boom")
        with pytest.raises(GoveeHTTPError):
            await adapter.execute(Command(name="power_cycle"))
        assert (await adapter.health()).status is HealthStatus.ERROR
        # plug is genuinely still off in the cloud state
        fake.state_props = [{"online": True}, {"powerState": "off"}]
        await adapter._connect_and_poll()
        adapter._mark_poll_success("polled")
        health = await adapter.health()
        assert health.status is HealthStatus.ERROR  # latched, not cleared
        assert "POWER CYCLE FAILED" in health.detail
    finally:
        await adapter.stop()


async def test_latched_failure_clears_once_plug_observed_on_again(monkeypatch):
    monkeypatch.setattr(govee_adapter, "POWER_ON_RETRY_DELAY_S", 0.01)
    adapter, fake, _ = make_adapter()
    await adapter.start()
    try:
        fake.control_exc["on"] = GoveeHTTPError(500, "boom")
        with pytest.raises(GoveeHTTPError):
            await adapter.execute(Command(name="power_cycle"))
        assert (await adapter.health()).status is HealthStatus.ERROR
        # owner flipped it back on (or a later command did) — poll sees it ON
        fake.state_props = [{"online": True}, {"powerState": "on"}]
        await adapter._connect_and_poll()
        adapter._mark_poll_success("polled")
        assert (await adapter.health()).status is HealthStatus.OK
    finally:
        await adapter.stop()


async def test_a_successful_power_command_clears_a_latched_failure(monkeypatch):
    monkeypatch.setattr(govee_adapter, "POWER_ON_RETRY_DELAY_S", 0.01)
    adapter, fake, _ = make_adapter()
    await adapter.start()
    try:
        fake.control_exc["on"] = GoveeHTTPError(500, "boom")
        with pytest.raises(GoveeHTTPError):
            await adapter.execute(Command(name="power_cycle"))
        assert (await adapter.health()).status is HealthStatus.ERROR
        fake.control_exc.clear()  # cloud recovered
        await adapter.execute(Command(name="power_on"))
        assert (await adapter.health()).status is HealthStatus.OK
    finally:
        await adapter.stop()


def test_on_retry_delay_honors_capped_retry_after():
    """The ON-step back-off uses a 429's Retry-After (capped at the request
    timeout) instead of the fixed 3s, so retries don't all burn inside one
    rate-limit window; non-rate-limit errors keep the fixed delay."""
    from app.adapters.govee.adapter import (
        POWER_ON_RETRY_DELAY_S,
        REQUEST_TIMEOUT_S,
        GoveePlugAdapter,
    )

    assert GoveePlugAdapter._on_retry_delay(GoveeRateLimitError(20.0)) == 20.0
    # capped at the per-request timeout, never an unbounded server value
    assert (
        GoveePlugAdapter._on_retry_delay(GoveeRateLimitError(9999.0))
        == REQUEST_TIMEOUT_S
    )
    assert (
        GoveePlugAdapter._on_retry_delay(GoveeRateLimitError(None))
        == POWER_ON_RETRY_DELAY_S
    )
    assert (
        GoveePlugAdapter._on_retry_delay(GoveeHTTPError(500)) == POWER_ON_RETRY_DELAY_S
    )


async def test_cycle_off_failure_aborts_before_the_sleep():
    adapter, fake, events = make_adapter()
    await adapter.start()
    try:
        fake.control_exc["off"] = GoveeHTTPError(500, "boom")
        with pytest.raises(GoveeHTTPError):
            await adapter.execute(Command(name="power_cycle"))
        assert [call[2] for call in fake.control_calls] == ["off"]
        assert events[-1]["step"] == "failed"
        assert events[-1]["during"] == "off"
        # plug never switched: optimistic state must still say ON is unknown
        # (the poll's last word stands — "off" from the fake's state_props)
        assert (await adapter.get_state()).attributes["power_on"] is False
    finally:
        await adapter.stop()


async def test_event_hook_failure_does_not_break_the_cycle():
    adapter, fake, _ = make_adapter()

    async def broken_hook(data: dict[str, Any]) -> None:
        raise RuntimeError("db down")

    adapter.on_event = broken_hook
    await adapter.start()
    try:
        result = await adapter.execute(Command(name="power_cycle"))
        assert result["accepted"] is True
        assert [call[2] for call in fake.control_calls] == ["off", "on"]
    finally:
        await adapter.stop()


async def test_command_success_does_not_fake_poll_freshness():
    adapter, fake, _ = make_adapter()
    await adapter.start()
    try:
        adapter._mark_failure("poll failed: simulated")
        before = (await adapter.health()).consecutive_failures
        await adapter.execute(Command(name="power_on"))
        health = await adapter.health()
        assert health.consecutive_failures == before  # command ≠ state refresh
        assert health.status is HealthStatus.DEGRADED
    finally:
        await adapter.stop()
