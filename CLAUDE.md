# CLAUDE.md — Cat HQ

Custom app to monitor and control cat devices: Litter-Robot 4 (Whisker cloud,
via `pylitterbot`), Petlibro PLAF103 Granary feeder (Petlibro cloud, client
ported from the jjjonesjr33/petlibro HA integration), and a Tapo camera (local
RTSP via go2rtc). Everything runs on one home box: FastAPI + SQLite backend,
React PWA frontend, Tailscale for remote access.

## Read first, every session
1. `docs/00-PROJECT-BRIEF.md` — what/why, device table, session protocol
2. `docs/01-ARCHITECTURE.md` — components, stack, repo layout, settled decisions
3. `docs/02-INTEGRATIONS.md` — per-vendor quirks and gotchas (important)
4. `docs/03-ROADMAP.md` — milestones M0–M9 with acceptance criteria; check the
   status table and resume at the first unchecked box

## Working rules
- The brief's working agreement ("Claude writes, owner runs") predates Claude
  Code. Updated split: you MAY run builds, containers, tests, and curl checks
  yourself. ASK the owner before any action that moves a physical device
  (manual feed, clean cycle) or logs into a vendor cloud for the first time —
  they need to watch the hardware.
- Secrets live only in `.env` (gitignored). Keep `.env.example` in sync with
  every new variable. Never echo `.env` contents or credentials into output,
  commits, or logs.
- Write complete, runnable files. Respect the repo layout in `docs/01`.
- When a milestone's acceptance criteria pass, update the checkboxes and the
  status table in `docs/03-ROADMAP.md`, then commit.
- Unofficial APIs (Whisker, Petlibro) break sometimes. On weird failures,
  check the relevant library's GitHub issues (links in `docs/02`) before
  deep debugging.
- Vendor clouds: poll ~60s with jitter and exponential backoff. Never
  tight-loop against them, even while debugging.
- Don't re-litigate settled decisions (`docs/01`) unless something is broken.
- Commit small and at least once per milestone.

## Commands
- Full stack: `docker compose up -d --build`
- Health check: `curl http://localhost:8000/health`
- Backend logs: `docker compose logs -f backend`
- Backend dev loop (no Docker): `cd backend && pip install -e . && uvicorn app.main:app --reload`

## Current state (2026-07-05, session 4 PAUSED mid-M5, resuming tonight)
M0 ✅ M2 ✅ M3 ✅ accepted. M1/M4 still owe the owner-watched clean-cycle
test (two /ws clients open, owner watches the globe). ⚠ INCIDENT
2026-07-05 11:33 PDT: an M5 verify script accidentally fired
POST /devices/litterrobot/clean UNATTENDED — a docker rebuild had
silently failed (exit code masked by a pipe) so the OLD un-authed image
was still serving, and the "expect 401" probe executed for real. Cycle
completed fine (proves HTTP→Whisker→LR4 path), but tell the owner and
let THEM decide if the watched M1/M4 test still needs a rerun. Rule
added to memory: auth probes use GET-only endpoints; never pipe-mask
build exit codes.
M5 code-COMPLETE, NOT yet container-verified:
- backend: bearer auth on /devices+/events (app/auth.py; /health stays
  open), /ws auth via subprotocols ["cathq", token], SPA static serving
  from app/static, multi-stage Dockerfile (build context = repo ROOT).
- frontend/: Vite+React+TS PWA (Node 26 now on the Mac via brew);
  `npm run build` passes clean. Login → live dashboard (WS store w/
  reconnect) → litter+feeder cards → history view.
BLOCKED ON: Docker Hub DeadlineExceeded pulling base-image metadata
(twice today). Resume: retry `docker compose build backend` (check the
REAL exit code), `docker compose up -d`, then scripts/verify_m5.sh
(side-effect-free now), then scripts/smoke.cjs (playwright — install it
OUTSIDE frontend/, chromium already cached), then (if owner re-approves
workflows) scripts/m5-review.workflow.js, then tick docs/03 M5 boxes.
M5 acceptance ultimately needs the owner's phone (Add to Home Screen).
Devices live (cat: Pinsu; feeder "chutku food" on the DEDICATED
Petlibro account — never the owner's main account). Owner is
token-cost-conscious: work solo, no multi-agent workflows unless
explicitly requested (ultracode was enabled for session 4 only).
