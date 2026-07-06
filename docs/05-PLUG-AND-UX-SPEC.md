# Cat HQ — M5.5 Spec: Govee Power Control + Dashboard UX v2

Written 2026-07-05 (after M5 acceptance). Execution plan for a fresh session.
Read `docs/00`–`04` first per session protocol; this file is the WHAT and the
guardrails. Two independent parts — do Part A first (it changes the API
surface Part B renders), commit each part separately.

## Why

During the first phone-triggered clean (2026-07-05) the LR4 appeared stuck
mid-cycle. The event log shows no fault code and the cycle completed (likely
the cat-sensor pause), but real jams (pinch detect, over-torque) do happen
and the cloud command can't fix them — a mains power-cycle is the standard
remote remedy. The owner has Govee WiFi smart plugs
(amazon B08731J1L4 → H5081/H5083 family). Separately, dashboard v1 is
functional but visually flat; the owner wants it to feel alive.

## Part A — Govee plug adapter

### API facts (verify against the live API before trusting — unofficial-ish)

- Official Govee developer API. The OWNER must obtain the key: Govee Home
  app → profile tab → ⚙ Settings → "Apply for API Key" (arrives by email,
  usually minutes). Store as `GOVEE_API_KEY` in `.env` (hook already guards
  `*_KEY`; add empty entries to `.env.example`).
- v1 REST (start here; known to support these plugs):
  - `GET https://developer-api.govee.com/v1/devices` — header
    `Govee-API-Key: <key>`; lists devices with `device` (MAC-ish id),
    `model`, `deviceName`, `controllable`, `supportCmds`.
  - `PUT .../v1/devices/control` — body
    `{"device": ..., "model": ..., "cmd": {"name": "turn", "value": "on"|"off"}}`.
  - `GET .../v1/devices/state?device=...&model=...` — current on/off.
- There is a newer "Platform API" (openapi.api.govee.com) — do NOT chase it
  unless v1 rejects the plugs; keep the HTTP client isolated in
  `adapters/govee/client.py` so a swap stays cheap.
- Rate limits are tight (~10 req/min/device, daily caps). Poll state at 60s
  with jitter/backoff like every other adapter — never tighter. All the
  cross-cutting adapter rules from `docs/02` apply.
- Plugs have NO LAN API (that's lights-only) — this is cloud, treat as
  breakable like Whisker/Petlibro.

### Design

- `adapters/govee/`: `client.py` (aiohttp, key auth, typed errors) +
  `adapter.py` — ONE adapter instance per bound plug, `device_type: "plug"`,
  device_id `plug_litterrobot` (and future `plug_<x>`).
- **Explicit binding, never guessing**: env var
  `GOVEE_PLUG_LITTERROBOT=<deviceName as shown in the Govee app>`; the
  adapter resolves it against discovery and goes health-ERROR
  ("plug name not found; devices on account: <names>") on no match.
  Power commands are REFUSED for any plug not explicitly bound — switching
  the wrong mains socket (a fridge, an aquarium) is the failure mode that
  must be impossible.
- Commands via the standard `execute()`:
  - `power_on`, `power_off`
  - `power_cycle`: off → `asyncio.sleep(POWER_CYCLE_DELAY_S)` (default 8,
    env-tunable) → on; single-flight per plug (an asyncio.Lock — a second
    request while one runs gets a 409-mapped error, never a nested cycle);
    every step written to the event log (`event_type: "power"`).
- REST: plugs appear in `GET /devices` like everything else;
  `POST /devices/plug_litterrobot/cycle` (+ `/on`, `/off`), bearer-authed,
  same error mapping as other command routes.
- Health/state: on/off state, online flag, last poll. Litter card
  integration: when LR4 `is_online=false` AND its bound plug reports off,
  the UI should say so ("plug is off — that's why").
- LR4 power-restore behavior is UNKNOWN until observed (LR3 auto-cycled on
  boot; LR4 runs a startup sequence). The live drill (below) documents what
  actually happens in this spec's acceptance note afterwards.

### Safety rules (non-negotiable, extends CLAUDE.md physical-action rule)

1. Plugs switch MAINS POWER → every live on/off/cycle during development
   happens only with the owner watching, same as feed/clean.
2. Build and test the whole adapter against a mocked client first; the only
   live calls before the owner drill are read-only (device list, state).
3. NO automation: nothing may auto-power-cycle on a fault. That's an M8+
   discussion (alert → owner decides). The API exists; the trigger is human.
4. UI: power actions use a HOLD-to-confirm control (≥1.5s press), visually
   distinct (red zone at the card bottom), never adjacent to Clean/Feed.
5. Tests per docs/04: never touch the Govee cloud; the existing E2E scripts
   stay read-only (no power endpoints in them — see memory
   `no-side-effect-probes`).

### Owner-attended acceptance drill

With the owner watching the LR4: toggle plug off (app shows it), wait, on,
confirm LR4 boots and reaches Ready in the app; document observed
power-restore behavior in docs/03. Only then tick the milestone box.

## Part B — Dashboard UX v2

Direction: **"midnight den"** — keep the dark base and the existing layout
skeleton (header / cards / bottom tabs), add depth, life, and glanceability.
Hard constraints: ZERO new runtime dependencies (hand-rolled SVG + CSS only),
bundle stays under ~300 KB precache, touch targets ≥44px, safe-areas intact,
`prefers-reduced-motion` respected everywhere.

1. **Litter card**: replace the status text line with a status RING (SVG
   circle) around a cat glyph — green steady when RDY, amber sweep
   (indeterminate spin) during CST/CCP, red on fault codes with the code +
   plain-English label big underneath. Drawer % becomes a radial gauge,
   litter level a vertical fill tube. When a fault is showing and a bound
   plug exists, surface the power-cycle control right there (hold-to-confirm,
   red zone).
2. **Pinsu presence**: from `activity` events ("Cat Detected") — "Pinsu
   visited 12m ago" line with a paw icon; weight SPARKLINE (hand-rolled SVG,
   last ~14 `pet_weight` events, filter obvious scale noise: ignore samples
   >20% off the trailing median).
3. **Feeder card**: today's feeds as a 24h dot-timeline (dots sized by
   portions, "now" marker), next-feed as a live countdown ("in 2h 14m"),
   hopper/dispenser warnings as icon chips rather than full-width banners.
4. **Motion**: number tick animation on value change, bar/gauge transitions
   (already partly there), tab-switch slide, skeleton shimmer while the
   first snapshot loads, a small toast for WS reconnect instead of the
   full-width banner (banner stays only for >60s continuous offline).
5. **Header**: pixel-cat avatar + "Cat HQ", connection dot folded into the
   avatar (green ring live / grey pulsing reconnecting), uptime & adapter
   health in a tap-to-expand strip.
6. **History**: sticky day headers, type icons colored per device, fault
   events highlighted red, `power` events (Part A) rendered distinctly.

Process: implement, run `npm run build` + the extended smoke script,
post SCREENSHOTS for the owner (login, dashboard idle, dashboard during a
cycle if one happens naturally, history) BEFORE the docker rebuild that
replaces the live UI. Owner approves on the phone → tick the box.

## Session working rules

- Solo by default (owner is token-cost-conscious); multi-agent only if the
  owner explicitly enables it. Quote cost first if so.
- Part A first, separate commits. Tests land WITH the code (docs/04 rule 4);
  a parallel test session may be executing docs/04 — coordinate via git
  (small commits, rebase-friendly, don't touch `backend/tests/` files it
  owns beyond adding NEW test files for govee/UX).
- New env vars (`GOVEE_API_KEY=`, `GOVEE_PLUG_LITTERROBOT=`,
  `POWER_CYCLE_DELAY_S=8`) documented empty in `.env.example`; comments on
  their own lines (see the M0 inline-comment gotcha).
- Update docs/03 M5.5 checkboxes + status table as things land; commit per
  part; keep `scripts/verify_m5.sh`/`smoke.cjs` read-only.
