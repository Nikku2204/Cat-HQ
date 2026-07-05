# Cat HQ — Roadmap

## Status

| Field | Value |
|---|---|
| Current milestone | **M1 — Litter-Robot adapter** |
| Last updated | 2026-07-05 |
| Blockers | M1 needs `WHISKER_EMAIL`/`WHISKER_PASSWORD` in `.env` (owner watches first cloud login). Remaining fill-ins: cat names, Tapo model, timezone. Hardware purchase pending (dev on owner's Mac meanwhile — M0 accepted there; re-verify compose on the home box when it arrives). |

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
- [ ] Adapter wrapping pylitterbot: state, start-clean command, activity history
- [ ] Endpoints: `GET /devices/litterrobot`, `POST /devices/litterrobot/clean`

**Accept:** live drawer/cycle status from the real LR4; a clean cycle triggers from an HTTP call.

### M2 — Petlibro adapter (est. 15–25h) ⚠ highest risk
- [ ] Dedicated Petlibro account created and device shared to it
- [ ] Client ported from the HA integration; auth + session handling
- [ ] State, manual feed, feed log endpoints

**Accept:** a manual feed dispenses the intended portions via HTTP call; feed log matches the vendor app.

### M3 — Data layer (est. 8–12h)
- [ ] SQLite schema: events, state snapshots, notification ledger
- [ ] Pollers (60s, jitter, backoff) writing normalized events
- [ ] `GET /events` with device/time filters

**Accept:** events accumulate correctly across a backend restart.

### M4 — Live API (est. 6–10h)
- [ ] WebSocket channel broadcasting state changes
- [ ] REST surface finalized for v1

**Accept:** two open clients both update within seconds of a real device change.

### M5 — Dashboard v1 (est. 20–30h)
- [ ] PWA shell (installable, offline-tolerant), auth token login
- [ ] Status cards: litter (drawer %, last cycle, clean button), feeder (last feed, feed button), per-device health badges
- [ ] History view from `/events`

**Accept:** installed on the owner's phone; all statuses live on LAN.

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
