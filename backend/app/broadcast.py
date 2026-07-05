"""WebSocket hub (M4): fan-out of state changes to connected clients.

Single-sender design: publishers (adapter hooks) enqueue synchronously via
publish(); one sender task drains the queue and fans out. This keeps message
order stable and avoids concurrent send() calls on the same WebSocket, which
starlette does not guarantee to be safe.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

QUEUE_MAX = 1000  # backpressure: drop-oldest beyond this, never block a poll


class Hub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_MAX)
        self._sender_task: asyncio.Task[None] | None = None

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def start(self) -> None:
        self._sender_task = asyncio.create_task(self._sender(), name="hub-sender")

    async def stop(self) -> None:
        if self._sender_task is not None:
            self._sender_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._sender_task
            self._sender_task = None

    def register(self, ws: WebSocket) -> None:
        self._clients.add(ws)

    def unregister(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    def publish(self, message: dict[str, Any]) -> None:
        """Enqueue a message for all clients. Sync + non-blocking so adapter
        bookkeeping can call it from anywhere in the event loop."""
        try:
            self._queue.put_nowait(message)
        except asyncio.QueueFull:
            with suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()  # drop oldest — stale state is useless
            with suppress(asyncio.QueueFull):
                self._queue.put_nowait(message)

    async def _sender(self) -> None:
        while True:
            message = await self._queue.get()
            if not self._clients:
                continue
            dead: list[WebSocket] = []
            for ws in list(self._clients):
                try:
                    await ws.send_json(message)
                except Exception:  # noqa: BLE001 — any send failure = drop client
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)
            if dead:
                logger.info("hub: dropped %d dead client(s), %d remain",
                            len(dead), len(self._clients))
