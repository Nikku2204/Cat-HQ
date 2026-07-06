# Cat HQ — Roadmap

## Status

| Field | Value |
|---|---|
| Current milestone | **M5.5 — power control + UX v2**: code DEPLOYED to the live LAN container 2026-07-05 (Part A Govee adapter + Part B UX v2 "midnight den"), owner approved the look; only the owner-watched plug drill remains before full acceptance. M1 ✅ M4 ✅ M5 ✅. Then M6 (video). |
| Last updated | 2026-07-05 (late evening) |
| Blockers | Owner-watched plug drill pending (mains rule — owner must watch the LR4): toggle a plug off→on from the power zone, run a deliberate power-cycle, document the LR4 power-restore behavior. Govee key + both plug bindings live and connected read-only. Remaining fill-in: Tapo model. Hardware purchase pending. |

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
*ACCEPTED 2026-07-05 evening: owner triggered a clean from the installed
PWA and watched the machine — CST→CCP→Complete→RDY in the event log, drawer
38→50%. Perceived mid-cycle "stuck" left no fault code (likely the cat-
sensor pause); remote power-cycle capability queued as M5.5 (docs/05).*

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
*ACCEPTED 2026-07-05 evening: two-client broadcast was verified in the
plumbing test, and a real phone-triggered clean propagated its status
transitions to the PWA via LR4 push within seconds while the owner
watched — combination satisfies the criterion.*

### M5 — Dashboard v1 (est. 20–30h) ✅ 2026-07-05
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
*ACCEPTED 2026-07-05 evening: installed on the owner's phone, live statuses
on LAN, clean triggered from the installed app. ✅*

### M5.5 — Power control (Govee plugs) + UX v2 (est. 8–14h) — spec: `docs/05-PLUG-AND-UX-SPEC.md`
- [x] Govee adapter: client + discovery, explicit plug→appliance binding, state polling, `power_cycle` command (developed fully against mocks)
- [ ] Live verification WITH OWNER WATCHING: plug toggle, then a deliberate LR4 power-cycle recovery drill (plugs switch mains — physical-action rules apply)
- [x] Dashboard UX v2 per spec (status ring, gauges, Pinsu presence line, weight sparkline, feed timeline, motion) — owner approved via screenshots; DEPLOYED to the live LAN container 2026-07-05
- [x] Tests land with the code (docs/04 rule 4); smoke script extended read-only

*DEPLOYED 2026-07-05 (late session): `docker compose up -d --build` replaced
the live LAN container with Part A + Part B. Post-deploy /health: all four
adapters OK — litterrobot, feeder, and BOTH plug adapters bound+connected
(plug_litterrobot→"chutku potty", plug_feeder→"chutku food"; read-only
discovery only, no power command issued). verify_m5.sh 17/17 and the extended
smoke 19/19 pass against the live container; the "midnight den" UI is on the
phone. An adversarial review (4 lenses / 34 agents) BEFORE deploy found and
we fixed confirmed mains-safety bugs (commit 3931cfb) — the critical one where
a non-transient error on the power_cycle ON step (bad key / closed client)
escaped the loud-failure path and could strand the LR4 OFF silently; plus a
health latch so a routine poll can't clear a stranded-OFF ERROR, a
shutdown-grace budget (+ compose stop_grace_period 210s), and the HoldButton
touch/keyboard cancel gaps. REMAINING for full acceptance: the owner-watched
plug toggle + LR4 power-cycle recovery drill (mains rule — owner must watch
the hardware); document the LR4's observed power-restore behavior here
afterward, then tick the drill box.*

*Follow-up UX pass 2026-07-05 (owner feedback, redeployed): the FEEDER card
now also gets a power zone (its plug "chutku food" is bound), and the power
control was simplified to ONE context-aware button — "Hold to restart"
(off→wait→on) when the plug is on, "Hold to switch plug ON" when off. The
standalone OFF button was dropped from the UI (still on the API); "power-cycle"
was renamed to the plain "Restart" everywhere user-facing (backend command
stays power_cycle). Frontend suite 134; smoke 19/19 vs the live container.*

*Progress 2026-07-05 (late session): Part A landed fully against mocks —
`adapters/govee/` (v1 client + plug adapter), routes
`POST /devices/plug_{litterrobot,feeder}/{on,off,cycle}` (409 single-flight,
429 rate-limit mapping), `power` events from both the command hook and the
recorder poll diff, config/env (`POWER_CYCLE_DELAY_S=8`), 54 new tests
(client/adapter/routes), suite green. Safety per spec: exact-name binding
only (ERROR + account device list on no match), commands refused unbound,
power sequences shielded from request cancellation, ON-step retries then
goes loudly ERROR ("plug may still be OFF").*

*Live READ-ONLY verification 2026-07-05 (device list + one state call per
plug — zero control calls, per docs/05 safety rule 2): the key works on
the v1 API; both bindings resolve uniquely to H5083 plugs ("chutku potty"
→ plug_litterrobot, "chutku food" → plug_feeder), both online and ON,
`supportCmds: ["turn"]` — v1 supports these plugs, no Platform API needed.
The toggle/power-cycle drill still waits for the owner (mains rule). LR4
power-restore behavior: still UNKNOWN, document here after the drill.*

*Part B implemented 2026-07-05 (late session): "midnight den" UX v2 — status
ring + pixel-cat glyph, drawer radial gauge, litter fill tube, Pinsu presence
line + noise-filtered weight sparkline, feeder 24h dot-timeline + live
next-feed countdown, warning chips, header pixel-cat avatar with the
connection ring folded in + tap-to-expand health strip, reconnect toast
(banner only after 60s continuous offline), skeleton shimmer, tab slide,
history v2 (sticky day headers, device-tinted icons, red fault rows, power
events distinct, Power filter chip), and the RED power zone (HoldButton ≥1.5s,
auto-expands on fault, "plug is off — that's why" hint). Zero new runtime
deps; prefers-reduced-motion respected; precache 236 KiB (<300); touch ≥44px.
Frontend suite now 125 (was 85), backend 282; smoke.cjs extended read-only,
19/19 against the new build + live backend via the dev proxy. Screenshots
posted for owner approval (login, dashboard, plug row, simulated PD fault +
power zone, history, simulated power history, health strip) — docker rebuild
deliberately deferred until the owner approves the look.*

**Accept:** a stuck LR4 can be power-cycled from the phone with recovery visible in the app; owner likes the new look on their phone.

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
- [ ] Backend + frontend test suites green in one command each
      (`cd backend && pip install -e '.[test]' && pytest` ·
      `cd frontend && npm test`; suites backfilled for M0–M5 on
      2026-07-05 per docs/04 — from M6 on, new code lands with tests)

**Accept:** one week of daily use with no manual restarts.

## v1 = M0–M9 complete. Post-v1 ideas

Automations (litter cycle → camera snapshot into history; feed-time clips), per-cat weight/health trends from the LR4 scale, litter/waste analytics, ONVIF motion alerts, multi-cat visit attribution.

## Effort summary

~100–160 focused solo hours; with Claude generating code and the owner testing on real hardware, expect roughly 40–60 hands-on hours. Ongoing maintenance: a few hours/month, spiky around vendor changes.
