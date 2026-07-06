# Cat HQ

One custom app to monitor and control all cat devices: Litter-Robot 4 (Whisker
cloud), Petlibro Granary PLAF103 feeder (Petlibro cloud), and a Tapo camera
(local RTSP).

Project docs (brief / architecture / integrations / roadmap) live in `docs/`.
Current milestone: **M5 — dashboard v1** (M0–M4 backend done).

## Quickstart

Prereqs: Docker + Docker Compose on the home box (or your PC while developing).

```bash
cp .env.example .env        # fill in credentials; generate CATHQ_AUTH_TOKEN
docker compose up -d --build
curl http://localhost:8000/health
```

Then open `http://<box-ip>:8000` from any device on the LAN and paste the
`CATHQ_AUTH_TOKEN` value at the login screen. On a phone, use "Add to Home
Screen" to install the dashboard as an app. (Service-worker offline support
needs HTTPS and arrives with the Tailscale setup at M7.)

The backend image builds the frontend too (multi-stage) — `docker compose up
-d --build` is the whole deploy.

## Frontend dev loop

```bash
cd frontend
npm install
npm run dev        # Vite on :5173, proxies /devices /events /health /ws → :8000
```

## Layout

    docker-compose.yml     backend + go2rtc services
    .env.example           every config/credential variable, documented
    backend/               FastAPI app (Python 3.12); serves the built PWA
    frontend/              React + Vite PWA (TypeScript)
    go2rtc/go2rtc.yaml     video restreamer config (wired up for real at M6)
    data/                  created at runtime; SQLite lives here from M3

## Secrets & publishing safety

Rules that keep credentials out of git — they apply to every future change:

- Real values live **only in `.env`** (gitignored; verified never-tracked
  against full history on 2026-07-05). `.env.example` documents every
  variable with **empty** values — adding a config variable means adding an
  empty, commented line there, never a real value.
- A committed **pre-commit hook** enforces this mechanically. Enable it once
  per clone (git does not auto-install hooks):

      git config core.hooksPath scripts/githooks

  It blocks: staging any `.env*` file (except `.env.example`), non-empty
  TOKEN/PASSWORD/EMAIL values in `.env.example`, and any staged content
  containing an actual secret value from your local `.env`. It prints
  variable names only, never values.
- The backend **refuses to start** if `CATHQ_AUTH_TOKEN` is empty or still
  the placeholder — a default token in a public repo must never gate
  hardware.
- No git remote is configured today. Before ever pushing this repo anywhere:
  run `git ls-files | grep -i '\.env'` (must show only `.env.example`) and
  prefer a **private** repo — the docs contain personal details, and
  `backend/app/adapters/petlibro/` is a GPL-3.0-attributed port (fine to
  publish, but mind the license if the repo's own license ever changes).
- Never paste `.env` contents into logs, issues, or chats — including
  sessions with Claude.

## Working agreement

Claude writes code and may run builds/tests/curl checks; physical device
actions (feed, clean cycle) only happen with the owner watching. Secrets only
ever go in `.env` (gitignored), documented in `.env.example`.
