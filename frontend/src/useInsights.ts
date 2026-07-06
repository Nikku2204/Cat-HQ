import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import {
  ambientForHour,
  countToday,
  dayCells,
  laHour,
  litterFaultTimestamps,
  meanDailyVisits,
  mealsGoal,
  moodFor,
  offlineTimestamps,
  SEED_BAND,
  streakDays,
  usualVisitsByNow,
  visitTimestamps,
  weightSamplesFromEvents,
  weightSummary,
  type Ambient,
  type DayCell,
  type MealGoal,
  type MoodResult,
  type WeightBand,
  type WeightSummary,
} from './insights'
import type { Devices, EventOut, FeederAttrs, LitterAttrs } from './types'

const DAY_MS = 86_400_000
const WINDOW_DAYS = 90

interface RawEvents {
  weight: EventOut[]
  activity: EventOut[]
  feed: EventOut[]
  statusChange: EventOut[]
  connectivity: EventOut[]
  healthChange: EventOut[]
}

const EMPTY: RawEvents = {
  weight: [],
  activity: [],
  feed: [],
  statusChange: [],
  connectivity: [],
  healthChange: [],
}

export interface LitterState {
  code: string | null
  text: string
  online: boolean
  cycling: boolean
}

export interface DenModel {
  loading: boolean
  hasData: boolean
  anyOffline: boolean
  // hero
  ambient: Ambient
  mood: MoodResult
  minsSinceSeen: number | null
  lastVisitMs: number | null
  litter: LitterState | null
  // rings
  meals: MealGoal
  nextFeedUtc: string | null
  visitsToday: number
  usualVisits: number | null
  visitsDayTypical: number | null
  // weight
  weight: WeightSummary
  band: WeightBand
  liveWeight: number | null
  // vitals
  feederOnlineStreak: number
  noFaultStreak: number
  careCells: DayCell[]
}

/**
 * The Den's data layer. Fetches the trailing 90 days of the event types the
 * dashboard needs ONCE (memoized), re-fetching only when a meaningful live
 * value moves (weight, cycle count, feed count) — never on the 60s render
 * tick. All bucketing/derivation happens in insights.ts and is recomputed
 * from `nowMs` so countdowns and the mood stay fresh without refetching.
 *
 * Client-side by design (docs/06 T7): on a cold DB this is trivially cheap;
 * a precomputed /insights endpoint is a documented future option, not needed
 * to ship.
 */
export function useInsights(devices: Devices, nowMs: number): DenModel {
  const litterEntry = devices['litterrobot']
  const feederEntry = devices['feeder']
  const lAttrs = litterEntry?.state?.attributes as LitterAttrs | undefined
  const fAttrs = feederEntry?.state?.attributes as FeederAttrs | undefined

  const [events, setEvents] = useState<RawEvents>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const hasDevices = Boolean(litterEntry || feederEntry)

  // Re-fetch keys: only bump on real change, like the device cards do.
  const cycleCount = lAttrs?.cycle_count
  const petWeight = lAttrs?.pet_weight_lbs
  const feedCount = fAttrs?.today_feed_count

  // Keep the latest now for the fetch's `since` bound without making the tick
  // a fetch dependency (we don't refetch every render — only on real change).
  const nowMsRef = useRef(nowMs)
  nowMsRef.current = nowMs

  useEffect(() => {
    if (!hasDevices) return
    let stale = false
    const since = new Date(nowMsRef.current - WINDOW_DAYS * DAY_MS).toISOString()
    Promise.all([
      api.events({ device: 'litterrobot', type: 'pet_weight', since, limit: 1000 }),
      api.events({ device: 'litterrobot', type: 'activity', since, limit: 1000 }),
      api.events({ device: 'feeder', type: 'feed', since, limit: 1000 }),
      api.events({ device: 'litterrobot', type: 'status_change', since, limit: 1000 }),
      api.events({ type: 'connectivity', since, limit: 1000 }),
      api.events({ type: 'health_change', since, limit: 1000 }),
    ])
      .then(([w, a, f, sc, conn, hc]) => {
        if (stale) return
        setEvents({
          weight: w.events,
          activity: a.events,
          feed: f.events,
          statusChange: sc.events,
          connectivity: conn.events,
          healthChange: hc.events,
        })
        setLoaded(true)
      })
      .catch(() => {
        if (!stale) setLoaded(true) // fail-quiet: cold-start states carry it
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasDevices, cycleCount, petWeight, feedCount])

  return useMemo<DenModel>(() => {
    const litterEvents = {
      health: events.healthChange.filter((e) => e.device_id === 'litterrobot'),
    }
    const feederEvents = {
      conn: events.connectivity.filter((e) => e.device_id === 'feeder'),
      health: events.healthChange.filter((e) => e.device_id === 'feeder'),
    }

    // ── visits ──
    const visits = visitTimestamps(events.weight, events.activity)
    const visitsTodayCount = countToday(visits, nowMs)
    const lastVisitMs = visits.length ? visits[visits.length - 1] : null
    const minsSinceSeen =
      lastVisitMs != null ? (nowMs - lastVisitMs) / 60_000 : null
    const usualVisits = usualVisitsByNow(visits, nowMs)
    const visitsDayTypical = meanDailyVisits(visits, nowMs)

    // ── weight ──
    const series = weightSamplesFromEvents(events.weight)
    const liveWeight =
      lAttrs?.pet_weight_lbs != null && lAttrs.pet_weight_lbs > 0
        ? lAttrs.pet_weight_lbs
        : null
    const weight = weightSummary({
      series,
      liveLb: liveWeight,
      band: SEED_BAND,
      now: nowMs,
    })

    // ── meals ──
    const nextFeedUtc = fAttrs?.next_feed_time_utc ?? null
    const meals = mealsGoal({
      feedEvents: events.feed,
      now: nowMs,
      liveToday: fAttrs?.today_feed_count ?? null,
      nextFeedUtc,
    })

    // ── streaks (device/owner actions only) ──
    const firstObservedMs = earliestTs(events) ?? nowMs
    const feederOffline = offlineTimestamps(
      feederEvents.conn,
      feederEvents.health,
    )
    const litterFaults = litterFaultTimestamps(
      events.statusChange,
      litterEvents.health,
    )
    const feederOnlineStreak = streakDays(feederOffline, nowMs, firstObservedMs)
    const noFaultStreak = streakDays(litterFaults, nowMs, firstObservedMs)
    const careCells = dayCells(
      [...feederOffline, ...litterFaults],
      nowMs,
      12,
      firstObservedMs,
    )

    // ── litter live state ──
    const litter: LitterState | null = lAttrs
      ? {
          code: lAttrs.status_code ?? null,
          text: lAttrs.status_text ?? lAttrs.status_code ?? '—',
          online: lAttrs.is_online !== false,
          cycling: lAttrs.status_code === 'CCP',
        }
      : null

    const anyOffline =
      lAttrs?.is_online === false || fAttrs?.online === false

    // ── hero mood + ambient ──
    const hourNow = laHour(nowMs)
    const mood = moodFor({
      laHourNow: hourNow,
      minsSinceSeen,
      inBand: weight.inBand,
      anyOffline,
      visitsToday: visitsTodayCount,
    })
    const ambient = ambientForHour(hourNow)

    return {
      loading: hasDevices && !loaded,
      hasData: hasDevices,
      anyOffline,
      ambient,
      mood,
      minsSinceSeen,
      lastVisitMs,
      litter,
      meals,
      nextFeedUtc,
      visitsToday: visitsTodayCount,
      usualVisits,
      visitsDayTypical,
      weight,
      band: SEED_BAND,
      liveWeight,
      feederOnlineStreak,
      noFaultStreak,
      careCells,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, lAttrs, fAttrs, nowMs, hasDevices, loaded])
}

function earliestTs(events: RawEvents): number | null {
  let min = Infinity
  for (const arr of Object.values(events)) {
    for (const e of arr) {
      const t = new Date(e.ts_utc).getTime()
      if (Number.isFinite(t) && t < min) min = t
    }
  }
  return Number.isFinite(min) ? min : null
}
