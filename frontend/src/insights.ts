// The Den (M5.7) — pure insight math. NO React, NO network: everything here
// is a plain function so it unit-tests fast beside format.ts.
//
// THE #1 CORRECTNESS TRAP (docs/06 T1): every bit of *bucketing* — "today",
// per-day counts, per-hour counts, streaks — is done in America/Los_Angeles
// EXPLICITLY, never device-local. A late-night visit at 11:40pm PDT must land
// in the LA day it happened on, regardless of where the phone thinks it is.
// Display formatting (relTime etc.) stays in format.ts and is device-local by
// design (the owner's phone is already in the household tz).

import type { EventOut } from './types'

export const LA_TZ = 'America/Los_Angeles'

// Pinsu's healthy weight band, owner-provided (vet-ish range, 2026-07-06).
// Used as the shaded "normal band" and the seed so the weight tile is never
// blank during cold-start. Kept a const so a future /insights endpoint or a
// settings screen can override it in one place.
export const SEED_BAND: WeightBand = { low: 12.5, high: 14.0 }

// Baselines need ~a week before "usually N by now" means anything (docs/06
// health-discipline rule 3). Below this we say "still learning", never guess.
export const MIN_BASELINE_DAYS = 7

export interface WeightBand {
  low: number
  high: number
}

// ── LA-timezone primitives ───────────────────────────────────────────────
// One shared formatter (constructing Intl.DateTimeFormat is comparatively
// expensive). en-CA yields YYYY-MM-DD-ordered numeric parts + 24h clock.

const laFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: LA_TZ,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export type TimeInput = string | number | Date

function toMs(ts: TimeInput): number {
  return ts instanceof Date ? ts.getTime() : new Date(ts).getTime()
}

export interface LaParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
}

export function laPartsOf(ts: TimeInput): LaParts {
  const parts = laFmt.formatToParts(new Date(toMs(ts)))
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value
  // V8 renders midnight as hour "24" under hour12:false — normalize to 0.
  let hour = Number(m.hour)
  if (hour === 24) hour = 0
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour,
    minute: Number(m.minute),
    second: Number(m.second),
  }
}

/** 'YYYY-MM-DD' of the LA-local day an instant falls in. The canonical
 *  bucket key — string-comparable and DST-proof. */
export function laDayKey(ts: TimeInput): string {
  const p = laPartsOf(ts)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}

/** LA-local hour (0-23) an instant falls in. */
export function laHour(ts: TimeInput): number {
  return laPartsOf(ts).hour
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Minutes LA is offset from UTC at a given instant (negative west of UTC:
 *  −420 in PDT, −480 in PST). Derived, so DST is always correct. */
function laOffsetMinutes(utcMs: number): number {
  const p = laPartsOf(utcMs)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return (asUtc - utcMs) / 60000
}

/** UTC epoch-ms of LA-local midnight for the day an instant falls in. Anchors
 *  the offset lookup at noon so the 2am DST fold never corrupts it. */
export function laDayStartMs(ts: TimeInput): number {
  const p = laPartsOf(ts)
  const noon = Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0)
  const off = laOffsetMinutes(noon)
  return Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0) - off * 60000
}

/** The last `n` LA-day keys ending today, oldest → newest. Steps by
 *  re-anchoring each midnight so it never drifts across a DST boundary. */
export function laDayKeysBack(now: TimeInput, n: number): string[] {
  const keys: string[] = []
  let cursor = laDayStartMs(now)
  for (let i = 0; i < n; i++) {
    keys.push(laDayKey(cursor + 3_600_000)) // +1h stays safely inside the day
    cursor = laDayStartMs(cursor - 3_600_000) // −1h lands in the prior LA day
  }
  return keys.reverse()
}

// ── small numeric helpers ────────────────────────────────────────────────

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function median(vals: number[]): number {
  if (vals.length === 0) return NaN
  const s = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Trailing-window rolling median, same length as input. Element i is the
 *  median of the up-to-`w` samples ending at i (the smoothing line, docs/06
 *  T3 / docs/05 rule 2 — a 7-visit rolling median for weight). */
export function rollingMedian(vals: number[], w = 7): number[] {
  return vals.map((_, i) => median(vals.slice(Math.max(0, i - w + 1), i + 1)))
}

// ── litter visits ────────────────────────────────────────────────────────
// A "visit" = the cat used the box. Two honest signals: every pet_weight
// event IS a weigh-in visit (the LR4 scale fires when she steps in), and
// "Cat Detected" activity rows cover visits the scale didn't log. One physical
// visit can raise both, seconds apart — so we merge and collapse anything
// within COLLAPSE_MS into a single visit (matches LitterCard's convention).

const COLLAPSE_MS = 120_000

function isCatDetected(e: EventOut): boolean {
  return /cat detected/i.test(String(e.data?.['action'] ?? ''))
}

/** Merge pet_weight + "Cat Detected" activity into de-duplicated visit
 *  instants (epoch-ms, ascending). */
export function visitTimestamps(
  petWeightEvents: EventOut[],
  activityEvents: EventOut[],
): number[] {
  const times = [
    ...petWeightEvents.map((e) => toMs(e.ts_utc)),
    ...activityEvents.filter(isCatDetected).map((e) => toMs(e.ts_utc)),
  ]
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const t of times) {
    if (out.length && t - out[out.length - 1] <= COLLAPSE_MS) continue
    out.push(t)
  }
  return out
}

/** visits (or any instants) counted into LA-day buckets. */
export function countByLaDay(timestamps: TimeInput[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of timestamps) {
    const k = laDayKey(t)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/** How many of `timestamps` fall in the same LA-day as `now`. */
export function countToday(timestamps: TimeInput[], now: TimeInput): number {
  const today = laDayKey(now)
  let n = 0
  for (const t of timestamps) if (laDayKey(t) === today) n++
  return n
}

/**
 * "Usually N visits by now" — the trailing baseline for today's pace. Averages,
 * across recent complete days, how many visits had happened by this same
 * LA-hour. Returns null until MIN_BASELINE_DAYS of history exist (cold-start
 * honesty: no baseline ⇒ no comparison). Population = days that had ≥1 visit
 * (a device-offline day shouldn't drag the mean to zero).
 */
export function usualVisitsByNow(
  visits: number[],
  now: TimeInput,
  minDays = MIN_BASELINE_DAYS,
  lookback = 14,
): number | null {
  const nowHour = laHour(now)
  const todayKey = laDayKey(now)
  const daysSeen = new Set<string>()
  const byNow = new Map<string, number>()
  for (const t of visits) {
    const k = laDayKey(t)
    if (k === todayKey) continue
    daysSeen.add(k)
    if (laHour(t) <= nowHour) byNow.set(k, (byNow.get(k) ?? 0) + 1)
  }
  const days = [...daysSeen].sort().slice(-lookback)
  if (days.length < minDays) return null
  const total = days.reduce((s, k) => s + (byNow.get(k) ?? 0), 0)
  return total / days.length
}

/**
 * Mean FULL-day visit count over recent complete days — the honest denominator
 * for the hero's visits goal ring. Null until MIN_BASELINE_DAYS exist (docs/06
 * owner Q4: no visits ring on a cold DB). Rounded to a whole target by the
 * caller.
 */
export function meanDailyVisits(
  visits: number[],
  now: TimeInput,
  minDays = MIN_BASELINE_DAYS,
  lookback = 14,
): number | null {
  const todayKey = laDayKey(now)
  const perDay = new Map<string, number>()
  for (const t of visits) {
    const k = laDayKey(t)
    if (k === todayKey) continue
    perDay.set(k, (perDay.get(k) ?? 0) + 1)
  }
  const days = [...perDay.keys()].sort().slice(-lookback)
  if (days.length < minDays) return null
  const total = days.reduce((s, k) => s + (perDay.get(k) ?? 0), 0)
  return total / days.length
}

// ── meals ────────────────────────────────────────────────────────────────

/** Per-LA-day counts of an event stream (today excluded by default). */
export function dailyCounts(
  events: EventOut[],
  now: TimeInput,
  excludeToday = true,
): number[] {
  const todayKey = laDayKey(now)
  const m = new Map<string, number>()
  for (const e of events) {
    const k = laDayKey(e.ts_utc)
    if (excludeToday && k === todayKey) continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.values()]
}

/**
 * The cat's typical meals-per-day = the MODE of prior non-zero daily feed
 * counts (the schedule size shows up as the most common day; manual feeds are
 * the rare outliers). Ties break high (the fuller plan). Null until `minDays`
 * of history — the goal falls back to a live served+upcoming bound.
 */
export function typicalDailyMeals(
  feedEvents: EventOut[],
  now: TimeInput,
  minDays = 3,
): number | null {
  const counts = dailyCounts(feedEvents, now).filter((c) => c > 0)
  if (counts.length < minDays) return null
  const freq = new Map<number, number>()
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1)
  let best = counts[0]
  let bestF = 0
  for (const [val, f] of freq) {
    if (f > bestF || (f === bestF && val > best)) {
      best = val
      bestF = f
    }
  }
  return best
}

export interface MealGoal {
  served: number
  target: number
  pct: number
}

/**
 * Meals served vs a genuinely BOUNDED target (docs/06 owner Q4: feeds are the
 * one honestly-bounded goal on a cold DB). Target = the typical daily count
 * once history exists; before that, a live "served + one upcoming" bound so
 * the ring is never open-ended.
 */
export function mealsGoal(opts: {
  feedEvents: EventOut[]
  now: TimeInput
  liveToday?: number | null
  nextFeedUtc?: string | null
}): MealGoal {
  const { feedEvents, now, liveToday, nextFeedUtc } = opts
  const served = liveToday ?? countToday(feedEvents.map((e) => e.ts_utc), now)
  const typical = typicalDailyMeals(feedEvents, now)
  const upcoming =
    nextFeedUtc && toMs(nextFeedUtc) > toMs(now) ? 1 : 0
  let target = typical ?? Math.max(served + upcoming, 1)
  target = Math.max(target, served, 1)
  return { served, target, pct: clamp01(served / target) }
}

// ── weight ───────────────────────────────────────────────────────────────

export interface WeightSample {
  ts: number // epoch-ms
  lb: number
}

/**
 * Scale-noise filter that keeps timestamps aligned (the aligned sibling of
 * format.ts filterWeights). Drops non-positive reads and any sample >tol off
 * the trailing median of accepted samples (half-entries, litter clumps).
 * Input must be chronological ascending.
 */
export function filterWeightSeries(
  series: WeightSample[],
  window = 5,
  tol = 0.2,
): WeightSample[] {
  const out: WeightSample[] = []
  for (const s of series) {
    if (!Number.isFinite(s.lb) || s.lb <= 0) continue
    const recent = out.slice(-window)
    if (recent.length >= 2) {
      const med = median(recent.map((r) => r.lb))
      if (Math.abs(s.lb - med) > tol * med) continue
    }
    out.push(s)
  }
  return out
}

export interface WeightSummary {
  current: number | null
  smoothed: WeightSample[] // 7-visit rolling median, cleaned + aligned
  cleaned: WeightSample[] // outlier-filtered raw, aligned
  reference: number // "Pinsu's normal" center the delta is measured against
  deltaPct: number | null // (current − reference) / reference · 100
  inBand: boolean
  concern: 'weigh-in' | null // calm amber nudge; only a sustained multi-day dip
  points: number
}

const DAY_MS = 86_400_000

/**
 * The un-paywalled Whisker weight headline (docs/06 §3), computed honestly:
 * smooth BEFORE flagging, colour by band membership, and only raise a calm
 * "worth a weigh-in" on a SUSTAINED multi-day drop below the band — never on a
 * single jittery read.
 */
export function weightSummary(opts: {
  series: WeightSample[]
  liveLb?: number | null
  band?: WeightBand
  now: TimeInput
}): WeightSummary {
  const band = opts.band ?? SEED_BAND
  const nowMs = toMs(opts.now)
  const cleaned = filterWeightSeries(
    [...opts.series].sort((a, b) => a.ts - b.ts),
  )
  const lbs = cleaned.map((s) => s.lb)
  const med = rollingMedian(lbs, 7)
  const smoothed = cleaned.map((s, i) => ({ ts: s.ts, lb: med[i] }))

  const current =
    opts.liveLb != null && Number.isFinite(opts.liveLb) && opts.liveLb > 0
      ? opts.liveLb
      : lbs.length
        ? lbs[lbs.length - 1]
        : null

  const recent = cleaned
    .filter((s) => nowMs - s.ts <= 30 * DAY_MS)
    .map((s) => s.lb)
  const reference =
    recent.length >= 5 ? median(recent) : (band.low + band.high) / 2

  const deltaPct =
    current != null ? ((current - reference) / reference) * 100 : null
  const inBand = current == null ? true : current >= band.low && current <= band.high

  return {
    current,
    smoothed,
    cleaned,
    reference,
    deltaPct,
    inBand,
    concern: detectSustainedDip(smoothed, band, nowMs),
    points: cleaned.length,
  }
}

/**
 * A dip worth mentioning: the smoothed weight sits below the band floor across
 * a sustained multi-day stretch (≥3 recent smoothed points, spanning ≥2 LA
 * days, all under band.low, and not recovering). Deliberately conservative —
 * it defers to the vet and must never fire on noise.
 */
function detectSustainedDip(
  smoothed: WeightSample[],
  band: WeightBand,
  nowMs: number,
): 'weigh-in' | null {
  const window = smoothed.filter((s) => nowMs - s.ts <= 5 * DAY_MS)
  if (window.length < 3) return null
  const allBelow = window.every((s) => s.lb < band.low)
  if (!allBelow) return null
  const days = new Set(window.map((s) => laDayKey(s.ts)))
  if (days.size < 2) return null
  // not recovering: the latest smoothed point is at/below the window's start
  if (window[window.length - 1].lb > window[0].lb) return null
  return 'weigh-in'
}

// ── care streaks (owner/device actions only — never Pinsu's biology) ──────

/** Days since the last "bad" day, counting today. 0 if today already had one.
 *  Bounded at `firstObservedMs` so a 2-day-old DB never claims "no faults 90d".
 */
export function streakDays(
  badTimestamps: number[],
  now: TimeInput,
  firstObservedMs?: number | null,
  maxDays = 120,
): number {
  const badDays = new Set(badTimestamps.map((t) => laDayKey(t)))
  const firstKey = firstObservedMs != null ? laDayKey(firstObservedMs) : null
  let streak = 0
  let cursor = toMs(now)
  for (let i = 0; i < maxDays; i++) {
    const k = laDayKey(cursor)
    if (badDays.has(k)) break
    streak++
    if (firstKey && k <= firstKey) break // don't count before we were watching
    cursor = laDayStartMs(cursor) - 3_600_000
  }
  return streak
}

export interface DayCell {
  key: string
  bad: boolean
  pre: boolean // before we started observing → render faint, not green
}

/** The last `n` LA-days as care cells (oldest → newest) for the streak strip. */
export function dayCells(
  badTimestamps: number[],
  now: TimeInput,
  n = 12,
  firstObservedMs?: number | null,
): DayCell[] {
  const badDays = new Set(badTimestamps.map((t) => laDayKey(t)))
  const firstKey = firstObservedMs != null ? laDayKey(firstObservedMs) : null
  return laDayKeysBack(now, n).map((key) => ({
    key,
    bad: badDays.has(key),
    pre: firstKey ? key < firstKey : false,
  }))
}

// ── mood mascot + ambient scene (delight, rationed) ──────────────────────

export type Mood =
  | 'sleepy'
  | 'content'
  | 'restless'
  | 'justVisited'
  | 'quiet'
  | 'neutral'

export interface MoodResult {
  mood: Mood
  phrase: string
  emoji: string
}

/**
 * Pinsu's pose + a plain mood phrase from cadence, minutes-since-seen, the
 * weight band, and the local hour. A neutral "quiet so far" default so sparse
 * mornings never read as alarm; and an OUTAGE is always neutral+factual —
 * never a sad Pinsu (docs/06 non-guilt guardrail).
 */
export function moodFor(opts: {
  laHourNow: number
  minsSinceSeen: number | null
  inBand: boolean
  anyOffline: boolean
  visitsToday: number
}): MoodResult {
  const { laHourNow, minsSinceSeen, inBand, anyOffline, visitsToday } = opts
  if (anyOffline) {
    return { mood: 'neutral', phrase: 'Keeping an eye on things', emoji: '' }
  }
  if (minsSinceSeen != null && minsSinceSeen <= 5) {
    return { mood: 'justVisited', phrase: 'Just popped by', emoji: '👀' }
  }
  const night = laHourNow >= 22 || laHourNow < 6
  if (night) {
    return { mood: 'sleepy', phrase: 'All quiet in the den', emoji: '😴' }
  }
  // A busy last little while, right after a visit → restless/playful.
  if (minsSinceSeen != null && minsSinceSeen <= 30 && visitsToday >= 4) {
    return { mood: 'restless', phrase: 'Busy little paws today', emoji: '🐾' }
  }
  if (minsSinceSeen != null && minsSinceSeen <= 90 && inBand) {
    return { mood: 'content', phrase: 'Pottering about', emoji: '🐾' }
  }
  const morning = laHourNow >= 6 && laHourNow < 12
  if (morning && visitsToday <= 1) {
    return { mood: 'quiet', phrase: 'Quiet morning so far', emoji: '' }
  }
  return { mood: 'content', phrase: 'Having a calm day', emoji: '🐾' }
}

export interface Ambient {
  phase: 'night' | 'dawn' | 'day' | 'dusk'
  celestial: 'moon' | 'sun'
}

/** Time-of-day den theming from the LA hour (CSS supplies the gradients). */
export function ambientForHour(laHourNow: number): Ambient {
  if (laHourNow < 6) return { phase: 'night', celestial: 'moon' }
  if (laHourNow < 9) return { phase: 'dawn', celestial: 'sun' }
  if (laHourNow < 18) return { phase: 'day', celestial: 'sun' }
  if (laHourNow < 21) return { phase: 'dusk', celestial: 'sun' }
  return { phase: 'night', celestial: 'moon' }
}

// ── event helpers shared by the data hook ────────────────────────────────

const LR_FAULTS = new Set(['CSF', 'PD', 'OTF', 'BR'])

/** LR4 fault instants: a status_change into a mechanical fault code, or any
 *  health_change into error. */
export function litterFaultTimestamps(
  statusChanges: EventOut[],
  healthChanges: EventOut[],
): number[] {
  const out: number[] = []
  for (const e of statusChanges) {
    if (LR_FAULTS.has(String(e.data?.['to'] ?? ''))) out.push(toMs(e.ts_utc))
  }
  for (const e of healthChanges) {
    if (String(e.data?.['to'] ?? '') === 'error') out.push(toMs(e.ts_utc))
  }
  return out
}

/** Device-offline instants: a connectivity change to false, or a health_change
 *  into error (fail-loud). */
export function offlineTimestamps(
  connectivity: EventOut[],
  healthChanges: EventOut[],
): number[] {
  const out: number[] = []
  for (const e of connectivity) {
    if (e.data?.['to'] === false) out.push(toMs(e.ts_utc))
  }
  for (const e of healthChanges) {
    if (String(e.data?.['to'] ?? '') === 'error') out.push(toMs(e.ts_utc))
  }
  return out
}

/** Weight samples from pet_weight events (data.to = lbs), ascending. */
export function weightSamplesFromEvents(petWeightEvents: EventOut[]): WeightSample[] {
  return petWeightEvents
    .map((e) => ({ ts: toMs(e.ts_utc), lb: Number(e.data?.['to'] ?? NaN) }))
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.lb))
    .sort((a, b) => a.ts - b.ts)
}
