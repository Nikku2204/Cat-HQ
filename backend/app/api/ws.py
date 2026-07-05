"""WebSocket endpoint (M4).

Protocol (server → client JSON):
- on connect:      {"kind": "hello", "devices": {id: {"health": .., "state": ..}}}
- on any refresh:  {"kind": "state", "device_id": id, "health": .., "state": ..}

state is null while the adapter is disconnected — same fail-loud contract as
REST. Client → server messages are ignored (send anything as a keepalive).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter()


async def _device_snapshot(adapters) -> dict:
    devices = {}
    for device_id, adapter in adapters.items():
        health = await adapter.health()
        state = None
        if adapter.connected:
            state = (await adapter.get_state()).model_dump(mode="json")
        devices[device_id] = {
            "health": health.model_dump(mode="json"),
            "state": state,
        }
    return devices


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    hub = ws.app.state.hub
    adapters = ws.app.state.adapters
    await ws.accept()
    await ws.send_json({"kind": "hello", "devices": await _device_snapshot(adapters)})
    hub.register(ws)  # after hello: no hub send can interleave with it
    try:
        while True:
            await ws.receive_text()  # keepalives; content ignored
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(ws)
