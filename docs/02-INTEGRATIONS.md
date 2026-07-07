# Cat HQ — Device Integration Notes

Research snapshot as of 2026-07-05. All three integrations are unofficial except Tapo's local streaming protocols. Verify current state of each library at build time — check releases and open issues before pinning versions.

## 1. Litter-Robot 4 (Whisker) — the easy one

- **Library:** `pylitterbot` — https://github.com/natekspencer/pylitterbot (PyPI: `pip install pylitterbot`; 2025.3.0 was current as of April 2026 — pin whatever is latest at build time).
- **Auth:** Whisker account email + password. The library handles token acquisition/refresh; the adapter must handle its auth exceptions and re-login.
- **Capabilities we use:** robot status (cycle state, waste drawer level, litter level, night light, sleep mode), `start_cleaning()`, `give_snack` equivalent n/a for LR4, activity history, insights, pet/weight data from the built-in scale.
- **Nature:** reverse-engineered from the Whisker app; explicitly experimental and can stop working at any time. Pin the version; watch the repo's issues when things break.
- **Adapter notes:** poll every 60s; also investigate the library's update/subscription mechanism at build time to reduce polling.
- **Quirk (observed live 2026-07-06, M5.7):** the cloud updates `pet_weight_lbs` LAZILY — the recorder's `pet_weight` change event can land minutes (observed up to ~9 min, sometimes longer) after the physical visit. The vendor's "Cat Detected" activity rows carry the real visit timestamps and are the authoritative visit record; treat `pet_weight` events as weight VALUES only, not visit instants (the Den's `visitTimestamps` encodes this — Cat Detected primary, pet_weight only covering the ~10-min history-ingest lag).
- **Related:** the vendor activity feed also contains `Pet Weight Recorded: N lbs` rows with ACCURATE timestamps — a better-timestamped weigh-in source than the poll-diffed `pet_weight` events if per-visit weight timing ever matters (future refinement; the 30-day trend doesn't care about ±minutes).

## 2. Petlibro feeder — the risky one

- **No standalone library.** Port the API client from the open-source Home Assistant custom integration: https://github.com/jjjonesjr33/petlibro (client code lives under `custom_components/petlibro/`, notably the API/device modules). We extract only the HTTP client + device models into our own `adapters/petlibro.py`, keeping attribution/license from that repo.
- **Auth quirk (critical):** the Petlibro cloud allows only ONE active session per account. Create a **dedicated second Petlibro account**, share the feeder to it from the main account, and use the dedicated account's credentials in Cat HQ — otherwise the owner's phone app gets logged out.
- **Capabilities (vary by model — confirm once model is filled into the brief):** device status, manual feed (portions), feeding schedule read, feed logs; camera-equipped feeders (PLAF203) have a separate proprietary video path we are NOT attempting.
- **Adapter notes:** treat every endpoint as undocumented and changeable; log raw responses at debug level during development; poll ~60s; expect the port to be the single largest source of surprises in the project (budgeted 15–25h).

## 3. Tapo camera — officially local

- **Enable in the Tapo app first:** Advanced Settings → turn ON Third-Party Compatibility; create a "Camera Account" (username + password used only for local streaming — different from the TP-Link cloud login). Give the camera a static IP / DHCP reservation.
- **Streams:** `rtsp://CAM_USER:CAM_PASS@CAM_IP:554/stream1` (HD) and `.../stream2` (SD). Test with VLC before blaming code. ONVIF (motion events, PTZ discovery) is on port 2020.
- **go2rtc config:** point a stream at the RTSP URL; consume WebRTC in the PWA, HLS as fallback.
- **Optional control:** `pytapo` (https://github.com/JurajNyiri/pytapo) for pan/tilt, privacy mode, LED — same author as the widely used HA integration (https://github.com/JurajNyiri/HomeAssistant-Tapo-Control), which is a good reference for auth quirks after firmware updates.
- **Gotcha:** using an SD card and Tapo Care cloud recording at the same time disables RTSP/ONVIF output on the camera. Pick one.
- **Motion events (post-v1):** subscribe via ONVIF pullpoint or webhook; battery/solar Tapo models often don't expose ONVIF.

## 4. Govee smart plugs — the official-ish one (M5.5)

- **API:** official Govee developer API, v1 REST (`developer-api.govee.com/v1`),
  key auth via `Govee-API-Key` header. Client isolated in
  `backend/app/adapters/govee/client.py` so a swap to the newer Platform API
  (`openapi.api.govee.com`) stays cheap — do NOT chase that unless v1 breaks.
- **Verified live 2026-07-05 (read-only):** the owner's two plugs are model
  **H5083**, listed by v1 with `controllable: true`, `supportCmds: ["turn"]`,
  `retrievable: true`; state returns `online` + `powerState`. Bindings:
  "chutku potty" → `plug_litterrobot`, "chutku food" → `plug_feeder`. The
  account also has two Govee LIGHTS (H6110, H6056) — binding is exact
  deviceName match, so they can never be switched by accident.
- **Rate limits are TIGHT:** ~10 req/min/device plus daily caps. Poll at 60s
  with jitter/backoff like every adapter; a power_cycle costs ≤4 calls.
- **No LAN API for plugs** (that's lights-only) — this is cloud, treat as
  breakable like Whisker/Petlibro.
- **Quirk:** the v1 state endpoint can lag a control call by seconds and is
  known to return `online` as the STRING "false"/"true" — the adapter
  normalizes, and power commands update state optimistically until the next
  poll reconciles.
- **Safety (docs/05, non-negotiable):** plugs switch MAINS. Explicit binding
  only (`GOVEE_PLUG_*` env, exact name, health-ERROR on no match), commands
  refused unbound, single-flight per plug, no automation ever calls a power
  command — the trigger is always a human.

## Cross-cutting adapter rules

- Common interface: `get_state() -> DeviceState`, `execute(Command)`, `health() -> AdapterHealth`. Fail loudly: surfaced in the UI as a per-device health badge, never silent staleness.
- Backoff on errors (exponential, capped, with jitter); never hammer a vendor cloud.
- Timestamps stored UTC, rendered in the owner's timezone.
- If an adapter dies for more than a few days due to vendor changes: escape hatch = stand up Home Assistant, connect that one device there, and reimplement the adapter against HA's REST/WebSocket API. The rest of the app doesn't change.
