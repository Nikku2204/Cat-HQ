# Cat HQ

One custom app to monitor and control all cat devices: Litter-Robot 4 (Whisker
cloud), Petlibro Granary PLAF103 feeder (Petlibro cloud), and a Tapo camera
(local RTSP).

Project docs (brief / architecture / integrations / roadmap) live in the Claude
project knowledge, not in this repo. Current milestone: **M0 — scaffold**.

## Quickstart (M0)

Prereqs: Docker + Docker Compose on the home box (or your PC while developing).

```bash
cp .env.example .env        # fill in what you have; defaults are fine for M0
docker compose up -d --build
curl http://localhost:8000/health
```

From another device on the LAN: `http://<box-ip>:8000/health`.

**M0 acceptance:** `/health` returns JSON with build info. The go2rtc container
will also be up (web UI on port 1984) but its camera stream stays dormant until
M6 — that is expected.

## Layout

    docker-compose.yml     backend + go2rtc services
    .env.example           every config/credential variable, documented
    backend/               FastAPI app (Python 3.12)
    go2rtc/go2rtc.yaml     video restreamer config (wired up for real at M6)
    data/                  created at runtime; SQLite lives here from M3

## Working agreement

Claude writes code; the owner runs it against the real devices and pastes back
output/errors/logs. Secrets only ever go in `.env` (gitignored), documented in
`.env.example`.
