# Cat HQ — Project Brief

**One custom app to monitor and control all cat devices.** Fully from-scratch build (deliberately chosen as a learning project). Last updated: 2026-07-05.

## The devices

| Device | Vendor | Connection strategy |
|---|---|---|
| Tapo camera (model: _fill in_) | TP-Link | Local RTSP/ONVIF on home LAN — officially supported protocols |
| Litter-Robot 4 | Whisker | Whisker cloud via unofficial `pylitterbot` library |
| Smart feeder — **PLAF103 (Granary 5L WiFi)** | Petlibro | Petlibro cloud via client code ported from the open-source Home Assistant integration |

None of the three vendors offer an official public developer API. The Whisker and Petlibro paths are community reverse-engineered and may break when vendors change things — the architecture accounts for this (see "Settled decisions" in `01-ARCHITECTURE.md`).

## What v1 looks like

A PWA (installable web app) on the owner's phone showing, live: camera feed, litter box status (drawer level, last cycle, cycle button), and feeder status (last feed, manual feed button), plus event history and push notifications for problems. Runs entirely on a small always-on computer at home, reachable remotely through a secure tunnel.

## Routes considered (settled — do not re-litigate unless something breaks)

1. **Home Assistant only** — fastest, no code. Rejected because the owner wants a bespoke app and the learning experience.
2. **Hybrid: HA as backend + custom UI** — kept as the **escape hatch**: if a vendor adapter becomes unmaintainable, swap that adapter's internals to read from a local Home Assistant instance instead. Adapters are interfaces partly for this reason.
3. **Fully from scratch** — CHOSEN. ~100–160 solo hours; substantially less with Claude generating code and the owner testing on real devices.

## Fill in before the first build session

- Cat name(s): _fill in_
- Tapo camera model: _fill in_
- Petlibro feeder model: **PLAF103 (Granary 5L WiFi)** — confirmed supported by the jjjonesjr33/petlibro HA integration (listed as "Version 2"; verify against the owner's ~2022 unit early in M2)
- Home server hardware: **TBD — buying (used N100 mini PC or Pi 5)**; developing on owner's PC meanwhile
- Timezone: _fill in_
- Remote access preference: **Tailscale** (passes UDP → WebRTC works remotely; private by default)
- Bonus hardware on hand: Pi Zero 2 W + Camera Module 3 kit → earmarked as a second camera, post-v1

## For Claude: how to run a work session

1. Read all four project files: `00-PROJECT-BRIEF.md`, `01-ARCHITECTURE.md`, `02-INTEGRATIONS.md`, `03-ROADMAP.md`.
2. Check the status table at the top of `03-ROADMAP.md` and resume at the first unchecked milestone. If status is ambiguous, ask the owner one question to confirm.
3. Working agreement: Claude writes code and configs; the owner runs everything on their own machine/LAN against the real devices and pastes back output, errors, and logs. Claude cannot reach the devices directly.
4. Generate complete, runnable files (not fragments). Respect the repo layout in `01-ARCHITECTURE.md`.
5. Secrets never go in code or these docs — always via `.env` (gitignored), with `.env.example` kept current.
6. When a milestone's acceptance criteria pass, give the owner an updated roadmap snippet so they can update the file in project knowledge.
7. If an unofficial API misbehaves, check the relevant library's GitHub issues first (links in `02-INTEGRATIONS.md`) — breakage is usually already reported.
