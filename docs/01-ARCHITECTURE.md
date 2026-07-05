# Cat HQ — Architecture

## System overview

Everything runs on one always-on box on the home LAN, because the Tapo camera only speaks RTSP locally — a cloud server can never see it. The phone reaches the system through a secure tunnel, never through port forwarding.

```
Whisker cloud ──┐                          ┌── Petlibro cloud
                ▼                          ▼
        ┌──────────────── home LAN ────────────────┐
        │  FastAPI backend  ◄─ adapters + pollers   │
        │   │        ▲                              │
        │   │     SQLite (history/events)           │
        │   │                                       │
        │  go2rtc  ◄── RTSP ── Tapo camera          │
        └───┼───────────────────────────────────────┘
            ▼  (Tailscale / Cloudflare Tunnel)
        Phone: PWA (REST + WebSocket + WebRTC)
```

## Components and responsibilities

**FastAPI backend** — the heart. Owns vendor credentials; runs one async poller per cloud device (30–60s interval with jitter and exponential backoff); normalizes everything into internal models; persists events; serves REST for commands/queries and a WebSocket channel that broadcasts state changes to the UI. Adapters implement a common interface (`get_state()`, `execute(command)`, `health()`) so any one can be replaced — including by a Home Assistant-backed implementation (the escape hatch).

**go2rtc** — standalone binary/container. Ingests the camera's RTSP stream, serves WebRTC (primary, low latency) and HLS (fallback). The video path deliberately bypasses the backend. https://github.com/AlexxIT/go2rtc

**SQLite** — event log (feeds, cycles, faults, connectivity), latest-state snapshots, notification ledger. Accessed via SQLAlchemy. One household does not need more.

**Frontend PWA** — React + Vite. Status cards, action buttons, history views, embedded WebRTC player, service worker for installability and Web Push.

**Tunnel** — Tailscale (simplest: private mesh, app works only on your tailnet) or Cloudflare Tunnel (public HTTPS URL, put auth in front). Either way: zero open router ports.

## Tech stack (with rationale)

| Layer | Pick | Why |
|---|---|---|
| Backend | Python 3.12 + FastAPI | pylitterbot is async Python; FastAPI gives REST + WebSockets cheaply |
| DB | SQLite + SQLAlchemy | Zero-ops, plenty for one household |
| Scheduler | asyncio tasks | No Celery/Redis needed at this scale |
| Video | go2rtc | RTSP→WebRTC/HLS, battle-tested single binary |
| Frontend | React + Vite PWA | One codebase, installable, push-capable |
| Push | Web Push / VAPID (`pywebpush`) | No Apple/Google developer accounts |
| Packaging | Docker Compose | `backend` + `go2rtc` services; reproducible on any home box |
| Remote | Tailscale or Cloudflare Tunnel | Secure, free, no port forwarding |

## Repo layout

```
cat-hq/
├── docker-compose.yml
├── .env.example              # all secrets/config documented here
├── backend/
│   ├── pyproject.toml
│   └── app/
│       ├── main.py            # FastAPI app, lifespan starts pollers
│       ├── config.py          # env-driven settings
│       ├── adapters/          # base.py, litterrobot.py, petlibro.py, tapo.py
│       ├── pollers.py
│       ├── models.py          # SQLAlchemy + pydantic schemas
│       ├── api/               # routes: devices, events, actions, push
│       └── notify.py          # alert rules + web push
├── frontend/                  # Vite React PWA
└── go2rtc/go2rtc.yaml
```

## Security rules

- Secrets only in `.env` (gitignored); `.env.example` documents every variable.
- Single-user auth: one long random bearer token (upgrade to passkey later if desired).
- No WAN port forwarding, ever — tunnel only. Camera ports stay LAN-internal.
- Vendor credentials: Whisker account, dedicated Petlibro account (see `02-INTEGRATIONS.md`), Tapo Camera Account (local-only credentials, distinct from the TP-Link cloud login).

## Settled decisions

1. PWA, not native — revisit only if iOS push proves too annoying (adds ~30–50% effort).
2. SQLite, not Postgres.
3. Home-hosted, tunnel for remote — forced by the camera; also keeps cloud costs at zero.
4. Adapter pattern with fail-loud health reporting — unofficial APIs will break; the app should say so instead of silently showing stale data.
5. Hybrid escape hatch — any broken adapter can be reimplemented against a local Home Assistant instance without touching the rest of the app.
