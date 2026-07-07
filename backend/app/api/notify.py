"""POST /notify/test — send one WhatsApp test message (auth'd).

The ONLY notification endpoint: rules fire from the background engine, never
from HTTP. This exists so the owner can verify the CallMeBot pipe end-to-end
after setting credentials. E2E smoke never calls it (read-only rule).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(tags=["notify"])


@router.post("/notify/test")
async def notify_test(request: Request):
    notifier = getattr(request.app.state, "notifier", None)
    if notifier is None:
        raise HTTPException(
            status_code=503,
            detail="notifications not configured — set CALLMEBOT_PHONE and "
            "CALLMEBOT_API_KEY in .env",
        )
    delivered = await notifier.send_test()
    return {"channel": "whatsapp", "delivered": delivered}
