"""WebSocket endpoint (M4; auth added in M5).

Auth (M5): the handshake must carry the bearer token — either offered as a
Sec-WebSocket-Protocol entry alongside "cathq" (browsers: pass
["cathq", token] to the WebSocket constructor) or as an Authorization
header (non-browser clients). Bad/missing token → the handshake is denied
(client sees HTTP 403).

Protocol (server → client JSON):
- on connect:      {"kind": "hello", "devices": {id: {"health": .., "state": ..}}}
- on any refresh:  {"kind": "state", "device_id": id, "health": .., "state": ..}

state is null while the adapter is disconnected — same fail-loud contract as
REST. Client → server messages are ignored (send anything as a keepalive).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import WS_SUBPROTOCOL, ws_authenticated, ws_offered_subprotocols

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
    if not ws_authenticated(ws):
        # close() before accept() → starlette rejects the handshake (HTTP 403)
        logger.warning("rejected unauthenticated /ws from %s", ws.client)
        await ws.close(code=4401)
        return
    # Echo "cathq" when the browser offered it (RFC 6455: pick one of the
    # client's subprotocols or browsers fail the connection). Header clients
    # may offer none — then we accept without a subprotocol.
    subprotocol = (
        WS_SUBPROTOCOL if WS_SUBPROTOCOL in ws_offered_subprotocols(ws) else None
    )
    hub = ws.app.state.hub
    adapters = ws.app.state.adapters
    await ws.accept(subprotocol=subprotocol)
    await ws.send_json({"kind": "hello", "devices": await _device_snapshot(adapters)})
    hub.register(ws)  # after hello: no hub send can interleave with it
    try:
        while True:
            await ws.receive_text()  # keepalives; content ignored
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(ws)
