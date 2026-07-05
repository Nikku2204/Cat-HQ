# Cat HQ — Device Integration Notes

Research snapshot as of 2026-07-05. All three integrations are unofficial except Tapo's local streaming protocols. Verify current state of each library at build time — check releases and open issues before pinning versions.

## 1. Litter-Robot 4 (Whisker) — the easy one

- **Library:** `pylitterbot` — https://github.com/natekspencer/pylitterbot (PyPI: `pip install pylitterbot`; 2025.3.0 was current as of April 2026 — pin whatever is latest at build time).
- **Auth:** Whisker account email + password. The library handles token acquisition/refresh; the adapter must handle its auth exceptions and re-login.
- **Capabilities we use:** robot status (cycle state, waste drawer level, litter level, night light, sleep mode), `start_cleaning()`, `give_snack` equivalent n/a for LR4, activity history, insights, pet/weight data from the built-in scale.
- **Nature:** reverse-engineered from the Whisker app; explicitly experimental and can stop working at any time. Pin the version; watch the repo's issues when things break.
- **Adapter notes:** poll every 60s; also investigate the library's update/subscription mechanism at build time to reduce polling.

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

## Cross-cutting adapter rules

- Common interface: `get_state() -> DeviceState`, `execute(Command)`, `health() -> AdapterHealth`. Fail loudly: surfaced in the UI as a per-device health badge, never silent staleness.
- Backoff on errors (exponential, capped, with jitter); never hammer a vendor cloud.
- Timestamps stored UTC, rendered in the owner's timezone.
- If an adapter dies for more than a few days due to vendor changes: escape hatch = stand up Home Assistant, connect that one device there, and reimplement the adapter against HA's REST/WebSocket API. The rest of the app doesn't change.
