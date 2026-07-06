# Cat HQ — Roadmap

## Status

| Field | Value |
|---|---|
| Current milestone | **M5 — dashboard v1**: deployed + LAN-verified + reviewed; awaiting owner phone install for acceptance. Then M6 (video). M1/M4 watched clean-cycle test still owed. |
| Last updated | 2026-07-05 (evening session) |
| Blockers | M5 acceptance = owner installs PWA on phone. M1 clean-cycle test needs owner watching the LR4 (see M1 note: one cycle fired accidentally, unattended). Remaining fill-in: Tapo model. Hardware purchase pending. |

> For Claude: resume at the first milestone with unchecked boxes. When acceptance criteria pass, give the owner an updated copy of that milestone section to paste into this file.

## Milestones

### M0 — Scaffold (est. 4–6h) ✅ 2026-07-05
- [x] Repo per layout in `01-ARCHITECTURE.md`, with `docker-compose.yml` (backend + go2rtc)
- [x] `.env.example` covering all credentials/config; config loader in backend
- [x] `GET /health` endpoint returns build info

**Accept:** `docker compose up` on the home box serves `/health` on the LAN.
*Accepted 2026-07-05 on the owner's Mac (home box not purchased yet): both
containers healthy, `/health` returns build info, go2rtc UI on :1984.
Re-run `docker compose up` + LAN check when the home box arrives.
Fix along the way: no inline comments in env files — compose and
python-dotenv parse them inconsistently (empty value + comment ⇒ comment
becomes the value).*

### M1 — Litter-Robot adapter (est. 6–10h)
- [x] Adapter wrapping pylitterbot: state, start-clean command, activity history
- [x] Endpoints: `GET /devices/litterrobot`, `POST /devices/litterrobot/clean`

**Accept:** live drawer/cycle status from the real LR4; a clean cycle triggers from an HTTP call.
*Progress 2026-07-05: live state + activity history verified against the
real LR4 (pylitterbot==2025.6.1, poll-only, websocket deferred to M3/M4).
Clean-cycle trigger implemented but NOT yet fired — owner wants to watch;
scheduled 2026-07-06. Milestone accepted only after that passes.*
*Update 2026-07-05 11:33 PDT: a clean cycle WAS fired — accidentally and
unattended — by an M5 auth probe hitting the old un-authed image (Claude
error, see CLAUDE.md incident note). The LR4 cycled and returned to Ready,
so the HTTP→cloud→device path is proven; owner decides whether the formal
watched two-client test (M1+M4 acceptance) still runs as planned.*

### M2 — Petlibro adapter (est. 15–25h) ⚠ highest risk ✅ 2026-07-05
- [x] Dedicated Petlibro account created and device shared to it
- [x] Client ported from the HA integration; auth + session handling
- [x] State, manual feed, feed log endpoints

**Accept:** a manual feed dispenses the intended portions via HTTP call; feed log matches the vendor app.
*Accepted 2026-07-05: client ported from jjjonesjr33/petlibro (GPL-3.0,
attribution in adapters/petlibro/client.py) with hardened single-session
handling. Live PLAF103 ("chutku food", shared account, share_state=1):
state + 7-day feed log served; manual feed of 1 portion dispensed via
POST and confirmed as GRAIN_OUTPUT_SUCCESS in the log ~84s later.
Known quirks: battery_state="low"/pct=0 on mains (don't alert on this at
M8); enableFeedingPlan=false in realInfo despite active on-device
schedule — flag may live in baseInfo, fix queued with review findings.*

### M3 — Data layer (est. 8–12h) ✅ 2026-07-05
- [x] SQLite schema: events, state snapshots, notification ledger
- [x] Pollers (60s, jitter, backoff) writing normalized events
- [x] `GET /events` with device/time filters

**Accept:** events accumulate correctly across a backend restart.
*Accepted 2026-07-05: SQLite (WAL) via SQLAlchemy async + aiosqlite.
Recorder samples adapter in-memory state every ~60s (zero extra vendor
traffic) for change events + latest-state snapshots, and ingests vendor
history every ~10 min idempotently (UNIQUE dedupe keys). Restart test:
62 events before = 62 after, history re-ingest produced 0 duplicates;
diff baseline seeds from the DB so changes across downtime are caught.
GET /events supports device/type/since/until/limit.*

### M4 — Live API (est. 6–10h)
- [x] WebSocket channel broadcasting state changes
- [x] REST surface finalized for v1

**Accept:** two open clients both update within seconds of a real device change.
*Progress 2026-07-05: /ws serves hello snapshot + per-refresh state
broadcasts via a single-sender hub; LR4 websocket push ENABLED (HA
pattern: subscribe on connect, re-subscribe via load_robots each 5-min
reconcile) so litter changes propagate in seconds; feeder floor is its
60s poll (Petlibro has no push). REST v1: /health, /devices,
/devices/{litterrobot,feeder} + commands + histories, /events, /ws.
Two-client plumbing test PASSED (both clients received the same live
broadcast). Formal acceptance rides on the M1 clean-cycle test: watch
RDY→CCP arrive on two open clients within seconds.*

### M5 — Dashboard v1 (est. 20–30h)
- [x] PWA shell (installable, offline-tolerant), auth token login
- [x] Status cards: litter (drawer %, last cycle, clean button), feeder (last feed, feed button), per-device health badges
- [x] History view from `/events`

**Accept:** installed on the owner's phone; all statuses live on LAN.
*Progress 2026-07-05 evening: deployed and verified on LAN — 17/17 HTTP/WS
checks (scripts/verify_m5.sh) and 11/11 read-only browser checks
(scripts/smoke.cjs) pass against the live container with real device data.
Adversarial review (5 lenses, 27 agents): 17 confirmed findings, ALL fixed —
notably: backend now REFUSES to start with an unset/default auth token (the
repo-public "change-me" would have gated real hardware; the owner's .env was
still on it — a random token was generated 2026-07-05, read it with
`grep CATHQ_AUTH_TOKEN .env`); WS client socket lifecycle hardened (no
parallel-socket cascades); ConfirmButton ignores double-tap pass-through
(600ms arm delay); stale REST snapshots can't overwrite fresher WS state;
/docs+/openapi.json disabled unless ENABLE_DOCS=true; missing assets 404
instead of silently serving the shell; go2rtc pinned to 1.9.14.
Milestone accepted once the owner installs it on the phone (Add to Home
Screen at http://<mac-ip>:8000) and sees live statuses. Offline/service
worker needs HTTPS → verified at M7.*

### M6 — Live video (est. 12–20h)
- [ ] Tapo third-party compatibility + camera account done; RTSP verified in VLC
- [ ] go2rtc configured; WebRTC player in the PWA; snapshot endpoint

**Accept:** live view in the PWA with roughly ≤2s latency on LAN.

### M7 — Remote access + auth (est. 4–8h)
- [ ] Tailscale or Cloudflare Tunnel serving the app
- [ ] Auth verified from outside the LAN

**Accept:** full app, including video, works on cellular data.

### M8 — Push notifications (est. 10–15h)
- [ ] Service worker + VAPID web push (iOS requires the PWA installed to home screen)
- [ ] Alert rules: drawer full, feeder error/low food, device offline, cycle complete (configurable)
- [ ] Owner-requested absence rules (2026-07-05; easy via the M3 event log):
      no litter clean cycle in 24h; no feed dispensed in 12h; adapter/device
      unreachable (health ERROR or device offline beyond a grace period)
- [ ] NOTE: "backend itself is down" can't be pushed by a dead backend —
      needs an external watchdog (e.g. free healthchecks.io ping from the
      poller, or phone-side Tailscale status). Decide at M8.

**Accept:** a locked phone receives a push for a real triggered rule.

### M9 — Hardening (est. 15–25h)
- [ ] Token refresh + re-login flows for both cloud adapters
- [ ] Reconnect/backoff everywhere; errors surfaced in UI
- [ ] Runs unattended 24h and survives a router reboot

**Accept:** one week of daily use with no manual restarts.

## v1 = M0–M9 complete. Post-v1 ideas

Automations (litter cycle → camera snapshot into history; feed-time clips), per-cat weight/health trends from the LR4 scale, litter/waste analytics, ONVIF motion alerts, multi-cat visit attribution.

## Effort summary

~100–160 focused solo hours; with Claude generating code and the owner testing on real hardware, expect roughly 40–60 hands-on hours. Ongoing maintenance: a few hours/month, spiky around vendor changes.
