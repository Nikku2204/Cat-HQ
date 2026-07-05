"""SQLAlchemy models + pydantic response schemas (M3).

Timestamps are stored as ISO-8601 UTC strings ("...+00:00"): they sort
lexicographically, index cleanly in SQLite, and round-trip to JSON without
timezone surprises. Always write them via `iso_utc_now()` / `normalize_iso()`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel
from sqlalchemy import JSON, Boolean, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_iso(value: str | datetime) -> str:
    """Any aware datetime or ISO string → canonical UTC ISO string."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Event(Base):
    """Normalized device events — from state diffs ('poll'), vendor history
    ingestion ('history'), or command results ('command')."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(String(32), index=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    ts_utc: Mapped[str] = mapped_column(String(40), index=True)
    source: Mapped[str] = mapped_column(String(16))
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # Idempotent history ingestion: UNIQUE + insert-or-ignore. NULL for
    # poll-derived events (SQLite treats NULLs as distinct in UNIQUE indexes).
    dedupe_key: Mapped[str | None] = mapped_column(
        String(160), unique=True, nullable=True
    )


class DeviceStateRow(Base):
    """Latest-state snapshot, one row per device, upserted every sample.
    Also seeds the recorder's diff baseline across restarts."""

    __tablename__ = "device_state"

    device_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    updated_at_utc: Mapped[str] = mapped_column(String(40))
    attributes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    health: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class NotificationLedgerRow(Base):
    """Sent-notification ledger — populated from M8; schema exists from M3
    so the DB never needs a migration for it."""

    __tablename__ = "notification_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule: Mapped[str] = mapped_column(String(64), index=True)
    device_id: Mapped[str] = mapped_column(String(32), index=True)
    ts_utc: Mapped[str] = mapped_column(String(40), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    delivered: Mapped[bool] = mapped_column(Boolean, default=False)


# ── pydantic response schemas ────────────────────────────────────────────


class EventOut(BaseModel):
    id: int
    device_id: str
    event_type: str
    ts_utc: str
    source: str
    data: dict[str, Any]

    model_config = {"from_attributes": True}
