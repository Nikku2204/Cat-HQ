"""Common adapter interface — every device adapter implements this.

Settled decision #4 (01-ARCHITECTURE.md): fail loudly. health() feeds the
per-device badge in the UI; adapters must never silently serve stale data.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class HealthStatus(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"        # e.g. intermittent errors, retrying
    ERROR = "error"              # e.g. auth failed, vendor API changed
    UNCONFIGURED = "unconfigured"


class AdapterHealth(BaseModel):
    status: HealthStatus
    detail: str = ""
    last_success_utc: datetime | None = None
    consecutive_failures: int = 0


class DeviceState(BaseModel):
    device_id: str
    device_type: str             # "litterrobot" | "feeder" | "camera"
    fetched_at_utc: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    attributes: dict[str, Any] = Field(default_factory=dict)


class Command(BaseModel):
    name: str                    # e.g. "start_clean", "manual_feed"
    params: dict[str, Any] = Field(default_factory=dict)


class DeviceAdapter(ABC):
    """Implemented by litterrobot.py (M1), petlibro.py (M2), tapo.py (M6)."""

    device_id: str
    device_type: str

    @abstractmethod
    async def get_state(self) -> DeviceState: ...

    @abstractmethod
    async def execute(self, command: Command) -> dict[str, Any]: ...

    @abstractmethod
    async def health(self) -> AdapterHealth: ...
