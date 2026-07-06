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
5. `docs/04-TESTING.md` — testing spec (tooling settled, phased test cases).
   For a dedicated test-writing session: read it and execute the phases in
   order. For feature sessions: from M6 on, new code lands with its tests.

## Working rules
- The brief's working agreement ("Claude writes, owner runs") predates Claude
  Code. Updated split: you MAY run builds, containers, tests, and curl checks
  yourself. ASK the owner before any action that moves a physical device
  (manual feed, clean cycle) or logs into a vendor cloud for the first time —
  they need to watch the hardware.
- Secrets live only in `.env` (gitignored). Keep `.env.example` in sync with
  every new variable (empty values only). Never echo `.env` contents or
  credentials into output, commits, or logs. A pre-commit hook enforces this
  (scripts/githooks — active via core.hooksPath; see README "Secrets &
  publishing safety"). Never bypass it with --no-verify.
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

## Current state (2026-07-05, late evening — M0–M5 ALL ACCEPTED ✅)
PWA installed on the owner's phone, live on LAN, phone-triggered clean
verified (M1+M4+M5 accepted; see docs/03 notes). CATHQ_AUTH_TOKEN is a
real random value now (backend refuses ""/"change-me"; owner reads it
via `grep CATHQ_AUTH_TOKEN .env`). Secret safety is mechanized: pre-
commit hook at scripts/githooks (core.hooksPath is set locally; covers
*_TOKEN/_PASSWORD/_PASS/_EMAIL/_KEY/_SECRET), hardened .gitignore,
README "Secrets & publishing safety". No git remote exists.
NEXT UP — M5.5 (docs/05-PLUG-AND-UX-SPEC.md, fresh session): Govee
plug adapter for LR4 power-cycling (owner must first get GOVEE_API_KEY
via Govee Home app; plugs switch MAINS — physical-action rules apply,
explicit plug binding required, no automation) + dashboard UX v2
("midnight den", zero new runtime deps). A PARALLEL test session is
executing docs/04-TESTING.md — coordinate via small commits; don't
touch backend/tests/ files it owns.
Then M6 (Tapo camera: owner enables third-party compat + camera
account in the Tapo app, fills model into docs/00).
Tooling: Node 26 via brew; go2rtc pinned 1.9.14; playwright OUTSIDE
frontend/ (postinstall bloat); scripts/verify_m5.sh + smoke.cjs are
read-only BY DESIGN — never add command-endpoint probes (memory:
no-side-effect-probes).
Devices live (cat: Pinsu; feeder "chutku food" on the DEDICATED
Petlibro account — never the owner's main account). Owner is
token-cost-conscious: work solo, no multi-agent workflows unless
explicitly requested; quote cost first (session-4 review ran ~735k
tokens vs ~300–500k quoted — estimate high next time).
