# Cat HQ — M5.7 Spec: The Den (Insights Dashboard)

Written 2026-07-06 from a research + design pass (real cat/pet apps, cat-health
signals, mobile dashboard patterns, delight mechanics, hand-rolled dataviz
recipes). This is the WHAT and the guardrails for a fresh session. Read
`docs/00`–`04` first per the session protocol; `docs/05` is the sibling spec
whose conventions (zero deps, midnight-den, cat-friendly-but-plain-for-safety)
this one inherits.

## Why

Cat HQ already has **🏠 Home** (live control cards) and **🐾 Diary** (raw event
log). Neither answers the questions a cat owner actually asks at a glance: *Is
Pinsu OK? Is today normal? What did she get up to?* We already log the data to
answer them — every litter visit, her weight each visit (LR4 built-in scale),
every feed, cycles, and device health, all in our own SQLite with **no
retention cap**. Whisker paywalls exactly this (trends >30 days, daily recaps,
"advanced analytics" behind Whisker+); we can give it away, unlimited and free,
and make it *warm*. **The Den** is a third tab that turns the event log into
wellbeing trends and a daily story of Pinsu — glanceable, honest, and cute.

## The recommendation — "The Den" (🌙 Den)

A new **third tab**, `🌙 Den`, sitting between `🏠 Home` and `🐾 Diary`. Home
stays the default landing — never gate monitoring behind an insight
interstitial. The Den is a **midnight-den bento overview**: one hero, then a
2×2 KPI wall, then supporting trend tiles, then rationed delight. It is an
*additional* view — it never duplicates the control cards (Home) or the raw log
(Diary); it pins the story so the owner never has to scrub.

Built **entirely on data we already have**, with **zero new runtime deps**
(hand-rolled SVG + CSS), mobile-first, midnight-den styled, cat-friendly voice
(plain for anything touching power/safety).

## Hard constraints (non-negotiable — same spirit as docs/05)

- **Zero new runtime dependencies.** All charts are hand-rolled SVG + CSS. No
  chart library, no icon font, no date library. Reuse the existing viz
  primitives (see "Build map" below).
- **Precache stays < ~300 KB.** Share ONE sparkline component across every
  trend; don't ship per-widget assets. (Photos already load on demand, not
  precached — keep it that way.)
- **Mobile-first, one hand.** ≥44px touch targets, safe-areas intact, wide
  content (heatmap) scrolls inside its own `overflow-x: auto` — the page body
  never scrolls sideways.
- **`prefers-reduced-motion` respected everywhere.** Every ring fill, number
  tick, confetti, and ambient animation gates behind
  `@media (prefers-reduced-motion: no-preference)` with a static final-state
  fallback.
- **Timezone is America/Los_Angeles for ALL bucketing math** (see tech note
  T1 — this is the #1 correctness trap).
- **Honest, non-alarmist, never a diagnosis** (see the "Health discipline"
  rules — the #2 trap).
- **Accessibility:** every chart gets `role="img"` + `<title>`/`<desc>`
  carrying the takeaway; key numbers exposed as visually-hidden text.

## Sections (in render order; priority in brackets)

### 1. The Pinsu hero — "Pinsu, right now" [MUST]
The new landing of the tab. Left: Pinsu's real photo (`pinsu.jpg`) or the
mood mascot; right: two concentric **Apple-Fitness-style goal rings** for the
day — outer = litter visits vs. typical, inner = meals served vs. scheduled —
with the current weight + "±X% vs Pinsu's normal" delta chip beneath. One
plain-language mood sentence assembled at render ("Quiet morning so far · last
seen 40m ago"). Ambient time-of-day theming: the hero's radial-gradient deepens
overnight, a single CSS moon/sun tracks the local hour.
- **Widgets:** dual goal rings (visits / meals), big current weight + delta
  chip, live litter state chip (Ready / Cycling / Needs you), one mood
  sentence, mood mascot (pose from cadence + minutes-since-seen + weight-band +
  local hour, with a neutral "quiet so far" default), ambient den scene, plain
  "· device offline" chip when a device is down (mascot stays neutral —
  outages are never a sad Pinsu).
- **Dataviz:** a NEW `GoalRing` from the circumference formula (see T2). Center
  number reuses `TickNumber`. Mood swaps `PixelCat` rect-grid variants (new
  `mood` prop). Ambient scene = pure CSS radial-gradient presets by local hour
  + one absolutely-positioned SVG moon/sun. Rings carry `role="img"` +
  `<title>`/`<desc>`; delta chip colors ONLY outside the normal band.
- **Data:** live litter state (`pet_weight_lbs`, status, `last_seen_utc`,
  drawer/litter %); `/events?type=activity&since=<LA-midnight>` for today's
  visit count + cadence; `/events?type=feed` + live feeder
  (`today_feed_count`, `next_feed_time_utc`) for the meals ring;
  `/events?type=pet_weight&limit=…` for the 30-day median in the delta.

### 2. Vitals bento — the 2×2 KPI wall [MUST]
Tractive-style at-a-glance care status: four workhorse metrics, each
**self-baselined** and colored by inside/outside Pinsu's OWN normal band.
- **Tiles:** (a) Weight — big lbs + delta-vs-30-day-median badge + 14-day
  inline sparkline; (b) Visits today — "4 · usually 5 by now" with a faint
  normal-band marker; (c) Feeds — served vs scheduled as a small fill ring;
  (d) Care streak — "feeder online 12d · no LR4 faults 9d". Each tile shows a
  cold-start state ("still learning Pinsu's normal") when < 7 days of data.
- **Dataviz:** 12-col CSS Grid, even 16px gap; container-query collapse
  hero→full-width, tiles→2×2→stacked. Each tile is the canonical 4-layer stat
  card (label / big value / colored comparison / inline trend). Weight tile
  reuses the extended `Sparkline`; visits tile draws the baseline band as one
  translucent `<rect>` behind the number; feeds tile is a small `GoalRing`
  arc; streak tile is a flex row of rounded green/red day-cells (no SVG).
  **Color strictly by band membership**, never raw direction.
- **Data:** weight `/events?type=pet_weight`; visits `/events?type=activity`
  (today + trailing 7-day mean); feeds live `today_feed_count`/`next_feed` +
  `/events?type=feed`; streaks `/events?type=connectivity` & `health_change` &
  `status_change`(faults) + `HealthInfo` adapters/uptime.

### 3. Weight watch — the un-paywalled Whisker headline [MUST]
Clone Whisker's flagship built-in-scale baseline+deviation feature, free and
uncapped, but honest: smoothed, calm, suggestive — never a diagnosis. The
single highest-value clone.
- **Widgets:** big current weight (`TickNumber`) + "±X% vs Pinsu's normal"
  chip (colored only when out of band); 30/90-day sparkline with a shaded
  normal band + a faint 7-visit rolling-median line; min/max dot markers;
  30d/90d range toggle; cold-start "Still learning Pinsu's normal" until ~7
  days exist; a calm amber "worth a weigh-in" nudge ONLY on a sustained
  multi-day downward shift — never on single-point wobble.
- **Dataviz:** extend `Sparkline.tsx` (T3). Smooth BEFORE any flag; require a
  sustained shift. `role="img"` + `<desc>` with the takeaway number.
- **Data:** `/events?type=pet_weight` (Pinsu's per-visit LR4 lbs) + live
  `pet_weight_lbs`. Apply the docs/05 rule: discard samples >20% off the
  trailing median, then 7-visit rolling median, all client-side.

### 4. Rhythm — litter calendar heatmap + time-of-day [SHOULD]
Reveal Pinsu's routine so off-schedule days pop visually (Whisker's "what time
of day" + a GitHub contributions heatmap). Fixes the common "scrub the
timeline" complaint — pre-computed, not a scroll.
- **Widgets:** 7-row × ~12-week GitHub-style heatmap of daily litter-visit
  counts (horizontally scrollable); tap a day → jump to the Diary pre-filtered
  to that local day; 24-hour by-hour strip of when Pinsu usually goes, today
  overlaid; a "busiest hour" callout; honest sparse cold-start empty state.
- **Dataviz:** heatmap = CSS Grid of `<button>` cells
  (`grid-template-rows: repeat(7,1fr)` + `grid-auto-flow: column`), counts
  mapped to 4–5 **quantile** peach bins (not linear — sparse data looks
  blank), cells ≥12px, wrapped in `overflow-x:auto`, trailing ~12 weeks on
  phone, each cell `aria-label="Jul 3: 6 visits"`. **Memoize** — never
  re-render ~84 cells on the 60s poll; patch only changed day-cells. Hour strip
  = 24 unit-space `<rect>` bars, `shape-rendering: crispEdges`.
- **Data:** `/events?type=activity` over the trailing ~12 weeks, bucketed by
  America/Los_Angeles local DAY (heatmap) and local HOUR (strip).

### 5. Mealtime — scheduled vs actual [SHOULD]
Petlibro's killer reassurance — "did the scheduled feed actually fire?" — as a
glanceable timeline, not a raw log.
- **Widgets:** 24h lollipop timeline (ghost markers at scheduled times, filled
  dots at actual feeds sized by portions, missed/blocked flagged amber/red);
  live "now" marker + next-feed countdown; feeds-per-day mini bar chart with a
  "today vs typical" overlay line.
- **Dataviz:** lollipop in a uniform pixel-space viewBox so dots stay circular:
  `x = (minutesSinceMidnight/1440)·W` in LA local time, thin `<line>` stem +
  `<circle>` head; scheduled = hollow ghost, actual = filled peach,
  blocked/missed = `--bad`. Countdown via `TickNumber` recomputed client-side.
  Bars reuse `Bar.tsx` with a faint rolling-7-day mean overlay. Summary only —
  no scrollable list (that's Diary).
- **Data:** live feeder (`today_feed_count`, portions, `next_feed_time_utc`,
  `feeding_plan_enabled`); `/events?type=feed` & `feed_count_change` &
  `food_low` & `dispenser_blocked`.

### 6. Pinsu's Day — recap + notable-events strip [SHOULD]
Turn telemetry into a Wrapped-style "we see you" story and pin the standout
moments. The dashboard's whole reason to exist.
- **Widgets:** a dismissible daily recap card (one hero stat + 2–3 TRUE
  highlights — busiest hour, heaviest/lightest weigh-in, first & last visit);
  a notable-events strip (pinned cards: busiest hour, longest quiet gap, most
  recent fault); one plain-language "This week Pinsu…" line above the vitals.
- **Dataviz:** recap = hand-rolled CSS card, bold single-stat-per-line
  typography, assembled at a set LA-local time from the day's `/events`; a
  highlight renders ONLY when the underlying event genuinely exists (no
  padded/fake stats). Notable strip = horizontal snap-scroll in `overflow-x`.
  Dismissed state in `localStorage`; additive and non-blocking.
- **Data:** `/events` for the LA-local day/week.

### 7. Looking ahead — supplies forecast + device streaks [COULD]
A predictive insight no vendor app surfaces well, plus non-guilt device/care
streaks (owner/device actions, never Pinsu's biology).
- **Widgets:** "Drawer likely full in ~3 days" and "Litter low in ~N days"
  forecast tiles; per-device uptime streak strips (LR4 / feeder / plug),
  degrading gently on a break; a lifetime cycles-per-day mini area trend.
- **Dataviz:** forecast = simple linear fit over recent
  `drawer_level_change` / `litter_level_change` slope projected to threshold,
  shown as a plain ETA label + a tiny projection sparkline reaching a dashed
  "FULL" line. Reuse `Gauge` for current %. Streak strips = flex rows of
  rounded day-cells. Cycles trend = a small closed-area `<path>`. Frame every
  forecast as a plain-copy estimate.
- **Data:** `/events?type=drawer_level_change` & `drawer_full` &
  `litter_level_change` (slope); `connectivity` & `health_change` (streaks);
  `status_change` fault codes + live `cycle_count`.

### 8. Rationed milestones + badge shelf [COULD]
Reserve real celebration for genuine landmarks so motion never becomes
wallpaper, plus a small collectible shelf of true mementos.
- **Widgets:** full-card CSS confetti ONLY at real landmarks (1,000th LR4
  cycle, first weight-stable month, a "perfect day" = all feeds on schedule +
  in-band visits); a gentle badge shelf ("Regular as clockwork",
  "Featherweight week", "Night owl") — collectible, never a locked/nagging
  checklist; everyday feeds/visits get a quiet non-animated state change.
- **Dataviz:** confetti = ~20 absolutely-positioned CSS-animated `<span>`
  particles mounted once at the landmark; `prefers-reduced-motion` → a static
  "Milestone!" banner. A fired-milestone id persisted in `localStorage` so it
  fires once. Badge shelf = a grid of pixel-art SVG tiles in the `PixelCat`
  style. Kept entirely out of the power/restart zone.
- **Data:** live `cycle_count` (crossing 1,000) + `status_change`;
  `pet_weight` stability window; feed adherence for "perfect day".

## Delight mechanics (tasteful, rationed)

- **Mood mascot** as the always-alive window into Pinsu's life: pixel-Pinsu's
  pose from visit cadence + minutes-since-seen + weight-band + local hour
  (curled asleep at 3am, ears-up just after a "Cat Detected", content mid-day),
  with a neutral "quiet so far" default so sparse mornings never read as alarm.
- **Ambient time-of-day den theming** so the surface always feels alive.
- **Day rings Pinsu closes** (not the owner) — a satisfying shape, zero
  pressure words.
- **Wrapped-style daily recap** — one hero stat + 2–3 always-true highlights,
  dismissible.
- **Rationed milestone celebration** — confetti strictly for real landmarks,
  fired once and persisted.
- **Gentle badge shelf** of mementos — collectible, never a checklist or nag.
- **Non-guilt guardrails:** outages render plain and factual, NEVER a sad
  Pinsu; streaks live only on owner/device actions with a grace day; health
  flags are calm-amber, suggestive, and defer to the vet — never red-shame,
  never a push notification.
- **Voice:** playful for litter/food/routine ("Bowl's on schedule", "Night
  owl", "First up · 6:14am"); Power/Restart and fault copy stay plain.

## Health discipline (the rules that keep this honest)

1. **Inverted color semantics.** MORE litter visits or LESS eating can be BAD
   (UTI/GI/illness). Color strictly by inside/outside the personal normal band
   — NEVER naive green=up / red=down.
2. **Smooth before you flag.** LR4 per-visit weight is jittery; discard >20%
   off the trailing median, take a 7-visit rolling median, and only flag a
   SUSTAINED multi-day shift. Never render a single-point spike as "weight
   loss".
3. **Cold-start honesty.** Baselines need ~7 days. Until then show "still
   learning Pinsu's normal" and real empty states — not a blank grid or a
   misleading flag.
4. **Suggestive, not diagnostic.** The strongest nudge is a calm amber "worth a
   weigh-in / worth a look" — it defers to the vet. No alarms, no red-shame, no
   push.

## Build map (reuse first — protect the bundle)

- **Reuse as-is:** `Gauge`, `Tube`, `Bar`, `TickNumber`, `PinsuAvatar`; the
  `format.ts` helpers (`relTime`, `fmtCountdown`, `filterWeights`,
  `prefersReducedMotion`).
- **NEW `GoalRing`** — do NOT reuse `Ring.tsx` (it's a *status* ring: mode
  ok/busy/bad/off with a CSS sweep, not a percent-fill arc). Build a small
  percent-fill arc from the circumference formula (T2). `Gauge`/`Tube` already
  use the dasharray idiom — reference them.
- **Extend `Sparkline.tsx`** (don't fork): add an optional normal-band
  `<rect>`, a faint rolling-median `<polyline>`, and min/max markers plotted in
  a uniform sub-viewBox so circles don't warp. Share this ONE component across
  weight, forecast, and KPI tiles.
- **Extend `PixelCat.tsx`** with a `mood`/`variant` prop swapping alternate
  rect grids (content / sleepy / restless / just-visited); idle micro-loop
  gated behind `prefers-reduced-motion`.
- **New:** the heatmap grid, the lollipop timeline, the recap card, the streak
  strip, the badge shelf, the LA-timezone bucketing helpers.

## Tech notes (traps the research surfaced — read before coding)

- **T1 — Timezone (the real correctness trap).** `format.ts` uses
  `toLocale*String([])` with no `timeZone`, i.e. device-local. Display on the
  owner's LA phone is fine, but ALL bucketing math (heatmap day cells, hour
  strip, streaks, "today", recap, feed lollipop) must bucket in
  **America/Los_Angeles explicitly**. Add `laDay(tsUtc)` / `laHour(tsUtc)`
  helpers via `Intl.DateTimeFormat({ timeZone: 'America/Los_Angeles' })` — never
  rely on device-local for math, or late-night visits leak into the wrong cell
  and streaks miscount.
- **T2 — GoalRing math.** `C = 2·π·r`; `stroke-dashoffset = C·(1−pct)` clamped
  ≥ 0; rotate the arc −90° to start at 12 o'clock; `stroke-linecap: round`;
  over-100% = a second layered arc at reduced opacity.
- **T3 — Sparkline retina.** Keep the raw line with
  `vector-effect: non-scaling-stroke`; plot dot markers in a UNIFORM sub-viewBox
  so they stay round under CSS stretch; don't put `crispEdges` on a diagonal.
- **T4 — `/events` paging.** Params `{device,type,since,until,limit}` →
  `{count, events}`, newest-first. Verify the limit cap (routes cite ≤1000). A
  90-day weight window or 12-week heatmap may need `until` cursoring. Fetch the
  trailing ~90 days ONCE and memoize; do NOT refetch or re-render the ~84-cell
  heatmap on the 60s poll — patch only changed cells.
- **T5 — Tab wiring.** The root component in `App.tsx` is (confusingly) named
  `Dashboard` and owns a `'status' | 'history'` union rendering 🏠 Home /
  🐾 Diary via `<div className="pane" key={tab}>`. Widen the union to add
  `'den'`, add a nav item labelled **Den**, keep Home the default landing.
- **T6 — Persistence.** Dismissed-recap and fired-milestone ids go in
  `localStorage` (per-device; cleared if the PWA is reset). No new deps.
- **T7 — Optional additive backend (flag as NEW per the brief).** Everything
  ships client-side for v1. IF the 90-day fetch or on-device baseline math gets
  heavy, propose a small additive `GET /insights` (precomputed baselines + daily
  recap) — new backend work, not required to ship. It would follow the existing
  route + auth + fail-loud conventions and land with its own in-process tests.

## Testing (tests land WITH the code — docs/04)

- Pure math (LA bucketing, quantile bins, rolling median / normal-band, streak
  counting, forecast slope, "today vs usual") → fast unit tests beside
  `format.ts`.
- Each dashboard component → colocated `*.test.tsx` (renders from seeded
  `/events`; cold-start state; reduced-motion path; no network).
- Any new `/insights` endpoint → in-process route tests with a seeded in-memory
  `/events`, same as the existing API suites.
- `scripts/smoke.cjs` gains a read-only "Den tab renders its sections" check.
  E2E stays read-only; no live cloud, no hardware.
- Screenshots (Den idle, cold-start, a populated day) posted for owner
  approval BEFORE the docker rebuild that ships it.

## Open questions for the owner — ANSWERED (build session 2026-07-06)

1. **Tab vs landing:** third `🌙 Den` tab, Home stays default. ✅ built.
2. **Timezone:** America/Los_Angeles is canonical for ALL bucketing. ✅
   (`insights.ts` laDayKey/laHour/laDayStartMs; DST-tested.)
3. **Weight baseline seed:** **12.5–14 lb** (owner). ✅ `SEED_BAND` — the shaded
   normal band + the cold-start reference; never blank.
4. **Visits goal:** feeds-only ring on a cold DB; the visits ring only appears
   once a 7-day baseline exists. ✅ hero renders one meals ring until then.
5. **Milestones:** cycle_count already ~6,544 (the 1,000th landmark is long
   past) → COULD section will use a forward landmark. (Not built this session.)
6. **History depth:** effectively cold-start (~1–2 days native). ✅ every
   section has a real cold-start/empty state, designed first.
7. **Persistence:** localStorage for dismissed-recap / fired-milestone ids —
   OK. (Used when the recap/milestones SHOULD/COULD sections land.)
8. **Recap timing:** **always live/rolling** for the current day (owner,
   2026-07-06). To apply when the Pinsu's-Day recap (SHOULD) is built.

### Shipped 2026-07-06 (MUST v1)
Hero + vitals bento + weight watch, the Den tab, and all shared infra
(`insights.ts` LA-tz + math, `GoalRing`, extended `Sparkline`, `PixelCat`
moods, `useInsights`). Client-side only — no `/insights` endpoint needed on a
cold DB (T7 stays a documented future option). SHOULD/COULD (heatmap,
mealtime, recap, forecasts, milestones) are the next session.

## Original open questions (kept for reference)

1. **Tab vs landing:** ship as a **third `🌙 Den` tab** with Home staying the
   default (recommended), or make it the landing view? Confirm the label/emoji.
2. **Timezone:** confirm America/Los_Angeles is the canonical bucketing tz
   regardless of the phone's locale.
3. **Weight baseline seed:** does Pinsu have a known healthy weight range / vet
   baseline to seed the "normal band" so the weight tile isn't blank for the
   first 7 days?
4. **Visits goal:** is a "typical visit count" meaningful enough to bound the
   OUTER day ring, or should the ring be feeds-only (a truly bounded goal)
   until a 7-day visit baseline exists?
5. **Milestones:** is cumulative `cycle_count` near a celebratory landmark
   (e.g. approaching 1,000)? Which milestones do you actually want celebrated?
6. **History depth:** how deep is the event log right now — do we have ~90 days
   to populate the heatmap and weight trend, or is this effectively a
   cold-start DB we should design the empty states around first?
7. **Persistence:** OK to persist dismissed-recap and fired-milestone ids in
   `localStorage` (per-device)?
8. **Recap timing:** assemble the daily recap at a fixed local "end of day"
   snapshot, or always live/rolling for the current day?

## Session working rules

- Solo by default (owner is token-cost-conscious); this spec came from an
  explicitly-enabled research pass. Quote cost before any further multi-agent
  run.
- Build in priority order: the **MUST** sections (hero + vitals + weight) are a
  shippable, genuinely-useful v1 on their own; SHOULD and COULD are follow-ons.
- New env vars? None expected (client-side v1). If `/insights` lands, document
  any new config empty in `.env.example` (comments on their own line — the M0
  gotcha).
- Update `docs/03` M5.7 checkboxes + status table as things land; keep
  `scripts/verify_m5.sh` / `smoke.cjs` read-only; screenshots before the
  live rebuild; owner approves on the phone → tick the box.
