"""Single-user bearer-token auth (M5).

01-ARCHITECTURE.md: "Single-user auth: one long random bearer token."
The token is CATHQ_AUTH_TOKEN in .env. /health and / stay unauthenticated
(no secrets there, and the docker-compose healthcheck relies on /health).

REST:      Authorization: Bearer <token>
WebSocket: browsers cannot set headers on WebSocket(), so the client offers
           Sec-WebSocket-Protocol: cathq, <token> and the server accepts the
           connection with subprotocol "cathq" (echoing one of the client's
           offers — required, or browsers fail the handshake). Non-browser
           clients may send the Authorization header instead.
"""
from __future__ import annotations

import secrets

from fastapi import HTTPException, WebSocket
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi import Depends

from .config import get_settings

WS_SUBPROTOCOL = "cathq"

_bearer = HTTPBearer(auto_error=False)


def _token_matches(candidate: str) -> bool:
    return secrets.compare_digest(
        candidate.encode(), get_settings().cathq_auth_token.encode()
    )


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """FastAPI dependency: 401 unless a valid bearer token is presented."""
    if credentials is None or not _token_matches(credentials.credentials):
        raise HTTPException(
            status_code=401,
            detail="missing or invalid bearer token (CATHQ_AUTH_TOKEN)",
            headers={"WWW-Authenticate": "Bearer"},
        )


def ws_offered_subprotocols(ws: WebSocket) -> list[str]:
    header = ws.headers.get("sec-websocket-protocol", "")
    return [p.strip() for p in header.split(",") if p.strip()]


def ws_authenticated(ws: WebSocket) -> bool:
    """True if the WS handshake carries a valid token (subprotocol entry or
    Authorization header). Compare against EVERY offer so a valid token is
    found regardless of order; compare_digest keeps each check constant-time."""
    auth = ws.headers.get("authorization", "")
    if auth.lower().startswith("bearer ") and _token_matches(auth[7:].strip()):
        return True
    found = False
    for offer in ws_offered_subprotocols(ws):
        if offer != WS_SUBPROTOCOL and _token_matches(offer):
            found = True  # no early return: uniform work per handshake
    return found
