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

## M5.7 "The Den" MUST v1 DEPLOYED 2026-07-06 (owner-approved, live on LAN)
Third 🌙 Den tab (between Home and Diary) — the insights dashboard, MUST
sections only per docs/06: "Pinsu, right now" hero (dual `GoalRing` +
weight pill + mood mascot + ambient time-of-day scene + live litter chip),
2×2 vitals bento (weight/visits/meals/care-streak), and un-paywalled Weight
Watch (band + 7-visit rolling-median line + 30/90d toggle + calm amber
"worth a weigh-in" only on a SUSTAINED dip). Built entirely CLIENT-SIDE on
`GET /events` (`useInsights` hook) — NO backend changes, no `/insights`
endpoint (T7 stays a future option on a cold DB). New/changed frontend:
`insights.ts` (all pure math + LA-tz bucketing helpers `laDayKey`/`laHour`/
`laDayStartMs` — DST-tested, the #1 trap), `GoalRing.tsx` (NEW percent-arc,
NOT the status `Ring`), extended `Sparkline.tsx` (band/median/markers,
backward-compatible), `PixelCat.tsx` mood prop, `Den.tsx`, `App.tsx` tab
wiring, `styles.css` `.den-*` block, `api.ts` gains `since`. Owner answers
baked in: weight normal band **12.5–14 lb** (`SEED_BAND`); daily recap
**always live** (for when the recap SHOULD lands); visits ring is
feeds-only until a 7-day baseline exists (cold DB → one meals ring now).
Everything cold-start-aware ("still learning") — the DB is only ~1–2 days
deep. Suites backend 287 / frontend 192 (+58); precache 261 KiB (<300);
zero new runtime deps; prefers-reduced-motion respected; read-only smoke
26/26. Owner approved the look from the screenshot and said "rebuild" →
DEPLOYED: `docker pull python:3.12-slim` (warm cache, deploy gotcha) then
`docker compose up -d --build`; post-deploy /health all four adapters ok,
backend healthy, served bundle is the new index-*.js with the Den; smoke
26/26 vs the LIVE container. MUST v1 is live on the phone. SHOULD/COULD
(heatmap, mealtime timeline, Wrapped recap [always-live], forecasts,
milestones/badges) are the next session. Built SOLO under ultracode effort
(owner said "work solo" in the prompt — honored despite workflow
orchestration being enabled).
CHUTKU MOOD CARD (2026-07-06 evening, owner request): top of Home; pure
ladder in insights.homeMood — plain fault/offline > litter grievances w/
actions > just-ate celebration (hearts, motion-gated, instant via live
feed-count bump) > pre-meal "scam" warning (≤35m) > approval > neutral.
NAMING RESOLVED (2026-07-06 late): the cat is **Chutku (he/him)
EVERYWHERE** — owner decision. All UI copy, tests, smoke, .env CAT_NAMES,
docs/00 renamed; ChutkuAvatar.tsx (was PinsuAvatar). Only the photo asset
FILENAMES keep pinsu*.jpg (binary churn not worth it).
MARMALADE THEME (2026-07-06 late, owner: "orange cat themed, playful"):
styles.css :root — espresso darks, cream text, marmalade accent #ff9e42
(Chutku IS an orange tabby), green ok (his eyes), SUNNY-YELLOW warn
(deliberately not orange so it can't blend into the accent), clear red
bad, sky-blue info. Icons/favicon/manifest #1b120c. ChutkuCat.tsx: NEW
hand-drawn SVG tabby on the mood card (replaces the pixel cat there ONLY;
PixelCat stays in header/Den) — per-pose expressions (happy/grumpy/alert/
awake), CSS idle animations (blink, tail sway/flick, pupil dart), all
reduced-motion-gated. Zero deps.
COZY-ROSE RETHEME (2026-07-06 evening, owner request "women friendly and
cuter"): the app-wide palette lives in styles.css `:root` — plum darks,
rose accent, lavender/mint/apricot, --on-accent for text-on-rose; --bad is
deliberately a CLEAR red distinct from the pink accent (mains power zone
must never look cute). ui-rounded font, radius 20px, rose favicon.svg +
PWA PNGs (regenerate via a playwright render if the svg changes),
manifest+meta theme_color #171019. Den vitals tiles are BUTTONS tapping
through to their story (Weight → Weight Watch scroll; Visits/Meals/Care →
Diary via HistoryView's `initialFilter` prop; Diary tab always opens All).
Day-1 accuracy pass (2026-07-06 evening): LR4 QUIRK — the cloud updates
pet_weight_lbs LAZILY (38s–9min+ after the visit; docs/02), which
double-counted visits. visitTimestamps now treats "Cat Detected" as
authoritative; pet_weight counts only >15 min past the newest vendor row
(ingest-lag cover — needed: one visit's Cat Detected was still missing 3h
later). Plus visibilitychange refetch in useInsights. Frontend 196 tests.

## Current state (2026-07-05, late evening — M0–M5.5 ALL ACCEPTED ✅)
PWA installed on the owner's phone, live on LAN, phone-triggered clean
verified (M1+M4+M5 accepted; see docs/03 notes). CATHQ_AUTH_TOKEN is a
real random value now (backend refuses ""/"change-me"; owner reads it
via `grep CATHQ_AUTH_TOKEN .env`). Secret safety is mechanized: pre-
commit hook at scripts/githooks (core.hooksPath is set locally; covers
*_TOKEN/_PASSWORD/_PASS/_EMAIL/_KEY/_SECRET), hardened .gitignore,
README "Secrets & publishing safety". No git remote exists.
M5.5 ✅ ACCEPTED 2026-07-05 (docs/05-PLUG-AND-UX-SPEC.md). Live LAN
container runs Part A (Govee plug adapter) + Part B (dashboard UX v2
"midnight den") + adversarial-review fixes + owner feedback. All four
adapters OK — litterrobot, feeder, and BOTH plugs bound+connected
(plug_litterrobot→"chutku potty", plug_feeder→"chutku food"). The
OWNER-WATCHED Restart drill PASSED: the plug cycled OFF→ON and the LR4
rebooted back to Ready (observed power-restore: it reaches Ready on its
own after mains returns). Shipped UX: single context-aware power control
labelled "Restart" (plain word for power_cycle; backend command name
unchanged), a power zone on BOTH cards, and Pinsu's real photos on the
login (face crop, pinsu-login.jpg) + litter status ring (pinsu.jpg);
tiny header keeps the pixel cat. Suites backend 287 / frontend 134;
precache ~281 KiB (<300); zero new runtime deps.
DEPLOY GOTCHA (2026-07-05): Docker Hub had a flaky window where
`compose up --build` timed out pulling python:3.12-slim layers; fix was
`docker pull python:3.12-slim` first (warms cache), then rebuild.
Owner UX taste (memory plain-minimal-ui): one obvious control, plain
words, hide edge cases in the API.
NEXT: owner approves the Den look on the phone → docker rebuild → tick
M5.7 Accept. Then either the M5.7 SHOULD/COULD sections or M6 (Tapo
camera — owner enables third-party compat + camera account in the Tapo
app, fills model into docs/00). The docs/04 test session is DONE; new
code lands with its tests.
Tooling: Node 26 via brew; go2rtc pinned 1.9.14; playwright OUTSIDE
frontend/ (postinstall bloat); scripts/verify_m5.sh + smoke.cjs are
read-only BY DESIGN — never add command-endpoint probes (memory:
no-side-effect-probes).
Devices live (cat: Pinsu; feeder "chutku food" on the DEDICATED
Petlibro account — never the owner's main account). Owner is
token-cost-conscious: work solo, no multi-agent workflows unless
explicitly requested; quote cost first (session-4 review ran ~735k
tokens vs ~300–500k quoted — estimate high next time).
