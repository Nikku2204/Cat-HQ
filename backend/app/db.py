"""Async SQLite plumbing (M3). One engine, WAL mode, tables auto-created —
a single household does not need migrations tooling; new tables/columns
arrive via CREATE IF NOT EXISTS at startup.
"""
from __future__ import annotations

import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    async_sessionmaker,
    create_async_engine,
)

from .config import get_settings
from .models import Base

settings = get_settings()

engine: AsyncEngine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.database_path}"
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    parent = os.path.dirname(settings.database_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    async with engine.begin() as conn:
        # WAL: readers never block the recorder's writes; survives crashes.
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(Base.metadata.create_all)


async def dispose_db() -> None:
    await engine.dispose()
