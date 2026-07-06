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

## Current state (2026-07-05, end of session 4)
M0 ✅ M2 ✅ M3 ✅ accepted. M5 deployed + LAN-verified + adversarially
reviewed (17 findings fixed, see docs/03 M5 note); ACCEPTANCE = owner
installs the PWA on the phone (http://<mac-ip>:8000 → Add to Home
Screen) and sees live statuses. CATHQ_AUTH_TOKEN was rotated off the
default on 2026-07-05 (backend now refuses to start on ""/"change-me");
owner reads it for login via `grep CATHQ_AUTH_TOKEN .env`. M1/M4 still
owe the owner-watched clean-cycle test (two /ws clients, watch the
globe) — note: one cycle fired accidentally unattended on 2026-07-05
(see docs/03 M1 note + memory no-side-effect-probes; auth probes are
GET-only now, never trust pipe-masked build exit codes).
Next: M6 (go2rtc + Tapo camera — needs owner: enable third-party
compat + camera account in the Tapo app, fill camera model into
docs/00). Testing spec ready in docs/04-TESTING.md for a dedicated
test session (owner plans to run one).
Tooling: Node 26 via brew on the Mac; go2rtc pinned 1.9.14; playwright
lives OUTSIDE frontend/ (its postinstall would bloat the Docker build);
E2E scripts in scripts/ (verify_m5.sh, smoke.cjs — both read-only by
design, they must NEVER hit clean/feed endpoints).
Devices live (cat: Pinsu; feeder "chutku food" on the DEDICATED
Petlibro account — never the owner's main account). Owner is
token-cost-conscious: work solo, no multi-agent workflows unless
explicitly requested (ultracode was enabled for session 4 only; the
review workflow ran ~735k tokens, owner-approved).
