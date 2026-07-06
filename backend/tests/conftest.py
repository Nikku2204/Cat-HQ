"""Shared fixtures for the Cat HQ backend test suite (docs/04-TESTING.md).

HARD RULES enforced here, structurally:

1. Tests never touch vendor clouds. The env hardening below runs at import
   time, BEFORE any `app.*` module is imported (pytest imports conftest
   first), so the module-level Settings/engine can never pick up real
   credentials from a stray `.env` or the shell environment — env vars
   override dotenv values in pydantic-settings. With no creds, the app
   lifespan configures ZERO real adapters; tests inject FakeAdapters.
2. Tests never move hardware. Command-path tests run against the in-process
   app with FakeAdapters only — there is no network I/O anywhere below.

DB strategy: `app/db.py` binds `engine`/`SessionLocal` at import, and
`app/api/events.py` + `app/main.py` import `SessionLocal` directly, so the
`db` fixture patches ALL of those references to a per-test in-memory engine
(StaticPool = one shared connection, so every session sees the same DB).

WebSocket tests: httpx has no WS support — use `starlette.testclient.
TestClient(app)` as a context manager (that runs the real lifespan: hub
started, adapters={} because no creds; inject fakes AFTER __enter__).
To publish through the hub from test code, hop into the client's portal
loop: `client.portal.call(app.state.hub.publish, message)` — the hub's
queue/sender live in that loop and asyncio queues are not thread-safe.
"""
from __future__ import annotations

import os

# ── env hardening — MUST stay above any other `app.*` import ────────────
# Derived from the Settings schema (app.config has no import-time side
# effects) so a future credential field — e.g. the GOVEE_API_KEY planned for
# M5.5 — is blanked automatically instead of depending on someone updating a
# hand-maintained list. Env vars override dotenv values in pydantic-settings,
# so this also neutralizes a repo-root .env when pytest runs from the root.
from app.config import Settings  # noqa: E402

_NON_SECRET_FIELDS = {"app_name", "version", "build_sha", "tz", "cat_names"}
for _field, _info in Settings.model_fields.items():
    if _field in _NON_SECRET_FIELDS:
        continue
    if _info.annotation is str:
        os.environ[_field.upper()] = ""  # secrets are all strings — blank them
    else:
        # bool/float knobs aren't secrets; "" wouldn't parse. Drop any shell
        # leakage and let the field's default apply.
        os.environ.pop(_field.upper(), None)
os.environ["CATHQ_AUTH_TOKEN"] = "test-token"
os.environ["DATABASE_PATH"] = ":memory:"  # inert; the db fixture patches engines anyway

from datetime import datetime, timezone  # noqa: E402
from typing import Any  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import app.api.events as events_api  # noqa: E402
import app.db as app_db  # noqa: E402
import app.main as app_main  # noqa: E402
from app.adapters.base import (  # noqa: E402
    AdapterHealth,
    Command,
    DeviceAdapter,
    DeviceState,
    HealthStatus,
)
from app.broadcast import Hub  # noqa: E402
from app.models import Base, Event  # noqa: E402

TEST_TOKEN = "test-token"
AUTH_HEADERS = {"Authorization": f"Bearer {TEST_TOKEN}"}


# ── fake adapter ─────────────────────────────────────────────────────────


class FakeAdapter(DeviceAdapter):
    """Scriptable in-memory adapter. Mutate the public attributes to script
    behavior; command/history calls record themselves for assertions.

    `execute_exc` / `activity_exc` / `feed_log_exc`: set to an exception
    INSTANCE to make that call raise it.
    """

    def __init__(
        self,
        device_id: str = "litterrobot",
        device_type: str | None = None,
        connected: bool = True,
        attributes: dict[str, Any] | None = None,
        health: AdapterHealth | None = None,
    ) -> None:
        self.device_id = device_id
        self.device_type = device_type or device_id
        self.connected_flag = connected
        self.attributes: dict[str, Any] = dict(attributes or {})
        self.health_obj = health or AdapterHealth(status=HealthStatus.OK, detail="fake")
        self.fetched_at = datetime.now(timezone.utc)
        self.on_refresh: Any = None
        # command scripting
        self.execute_result: dict[str, Any] | None = None
        self.execute_exc: BaseException | None = None
        self.executed: list[Command] = []
        # history scripting (recorder + /history endpoints)
        self.activity: list[dict[str, Any]] = []
        self.activity_exc: BaseException | None = None
        self.feed_log: list[dict[str, Any]] = []
        self.feed_log_exc: BaseException | None = None

    async def start(self) -> None:  # lifespan calls these on injected fakes
        pass

    async def stop(self) -> None:
        pass

    @property
    def connected(self) -> bool:
        return self.connected_flag

    async def get_state(self) -> DeviceState:
        if not self.connected_flag:
            raise RuntimeError(f"{self.device_id} fake adapter is not connected")
        return DeviceState(
            device_id=self.device_id,
            device_type=self.device_type,
            fetched_at_utc=self.fetched_at,
            attributes=dict(self.attributes),
        )

    async def execute(self, command: Command) -> dict[str, Any]:
        self.executed.append(command)
        if self.execute_exc is not None:
            raise self.execute_exc
        if self.execute_result is not None:
            return self.execute_result
        return {"command": command.name, "accepted": True}

    async def health(self) -> AdapterHealth:
        return self.health_obj

    async def get_activity(self, limit: int = 50) -> list[dict[str, Any]]:
        if self.activity_exc is not None:
            raise self.activity_exc
        return self.activity[:limit]

    async def get_feed_log(self, days: int = 7, limit: int = 50) -> list[dict[str, Any]]:
        if self.feed_log_exc is not None:
            raise self.feed_log_exc
        return self.feed_log[:limit]


# ── database ─────────────────────────────────────────────────────────────


@pytest.fixture
async def db(monkeypatch):
    """Fresh in-memory DB per test, patched into every module that holds a
    reference. Yields the session factory. Tests that hit /events or use the
    Recorder MUST request this fixture.

    Lifespan shutdown is defanged: dispose_db is patched to a no-op so
    exiting a TestClient context can't dispose this engine mid-test (the
    StaticPool would silently recreate an EMPTY :memory: db). The fixture
    disposes the engine itself at teardown."""
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _noop_dispose() -> None:
        pass

    monkeypatch.setattr(app_db, "engine", engine)
    monkeypatch.setattr(app_db, "SessionLocal", session_factory)
    monkeypatch.setattr(events_api, "SessionLocal", session_factory)
    monkeypatch.setattr(app_main, "SessionLocal", session_factory)
    monkeypatch.setattr(app_main, "dispose_db", _noop_dispose)
    yield session_factory
    await engine.dispose()


async def seed_events(session_factory, rows: list[dict[str, Any]]) -> None:
    """Insert event rows. Each row: device_id, event_type, ts_utc, source,
    data (dict), optional dedupe_key."""
    async with session_factory() as session:
        for row in rows:
            session.add(Event(**{"data": {}, "dedupe_key": None, **row}))
        await session.commit()


# ── app + clients ────────────────────────────────────────────────────────


@pytest.fixture
def app():
    """The real FastAPI app with per-test state: empty adapter dict and an
    UNSTARTED hub (register/publish only enqueue). Lifespan is NOT run —
    httpx's ASGITransport never runs it — so tests own app.state entirely.
    Add fakes via `app.state.adapters["litterrobot"] = FakeAdapter(...)`.
    """
    real_app = app_main.app
    _missing = object()  # restore faithfully: absent-before must be absent-after
    saved = {name: getattr(real_app.state, name, _missing) for name in ("adapters", "hub")}
    real_app.state.adapters = {}
    real_app.state.hub = Hub()
    yield real_app
    for name, value in saved.items():
        if value is _missing:
            delattr(real_app.state, name)
        else:
            setattr(real_app.state, name, value)


@pytest.fixture
async def client(app):
    """Authenticated REST client (bearer test-token pre-attached)."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers=AUTH_HEADERS
    ) as c:
        yield c


@pytest.fixture
async def anon_client(app):
    """REST client with NO Authorization header (for 401 tests)."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
