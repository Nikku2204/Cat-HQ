import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { isLrFault, prefersReducedMotion } from '../format'
import { homeMood } from '../insights'
import type { DeviceEntry, FeederAttrs, LitterAttrs } from '../types'
import ChutkuCat from './ChutkuCat'
import { isCleanCycleEvent } from './LitterCard'

/** Chutku's mood — the top of Home (owner request 2026-07-06). One quirky
 * line about how he's feeling + what (if anything) we should do, built from
 * the live device state and two tiny event lookups (last feed, last scoop).
 * All the ranking/copy lives in insights.homeMood (pure, tested); this
 * component just gathers inputs and celebrates. */
export default function MoodCard({
  litter,
  feeder,
}: {
  litter?: DeviceEntry
  feeder?: DeviceEntry
}) {
  const lAttrs = litter?.state?.attributes as LitterAttrs | undefined
  const fAttrs = feeder?.state?.attributes as FeederAttrs | undefined

  const [lastFeedMs, setLastFeedMs] = useState<number | null>(null)
  const [lastCycleMs, setLastCycleMs] = useState<number | null>(null)
  // 30s heartbeat: "just ate" expires and the pre-meal window opens on time
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // The event log lags the live poll by up to ~10 min (history ingest), so a
  // live today_feed_count bump = he ate RIGHT NOW — celebrate instantly.
  const feedCount = fAttrs?.today_feed_count
  const prevCount = useRef(feedCount)
  const [countBumpMs, setCountBumpMs] = useState<number | null>(null)
  useEffect(() => {
    if (
      prevCount.current != null &&
      feedCount != null &&
      feedCount > prevCount.current
    ) {
      setCountBumpMs(Date.now())
    }
    prevCount.current = feedCount
  }, [feedCount])

  // Small, targeted event lookups (same pattern as the cards); refetch only
  // when the relevant live counter moves.
  const cycleCount = lAttrs?.cycle_count
  useEffect(() => {
    if (!litter && !feeder) return
    let stale = false
    Promise.all([
      feeder
        ? api.events({ device: 'feeder', type: 'feed', limit: 1 })
        : Promise.resolve(null),
      litter
        ? api.events({ device: 'litterrobot', type: 'status_change', limit: 20 })
        : Promise.resolve(null),
      litter
        ? api.events({ device: 'litterrobot', type: 'activity', limit: 20 })
        : Promise.resolve(null),
    ])
      .then(([feeds, sc, act]) => {
        if (stale) return
        const feedTs = feeds?.events[0]?.ts_utc
        setLastFeedMs(feedTs ? new Date(feedTs).getTime() : null)
        const cycle = [...(sc?.events ?? []), ...(act?.events ?? [])]
          .filter(isCleanCycleEvent)
          .map((e) => new Date(e.ts_utc).getTime())
          .sort((a, b) => b - a)[0]
        setLastCycleMs(cycle ?? null)
      })
      .catch(() => {}) // unknown inputs → homeMood never grumps on unknowns
    return () => {
      stale = true
    }
  }, [litter != null, feeder != null, feedCount, cycleCount])

  if (!litter && !feeder) return null

  const mood = homeMood({
    now: nowMs,
    litter: lAttrs
      ? {
          online: lAttrs.is_online !== false,
          fault: isLrFault(lAttrs.status_code),
          litterPct: lAttrs.litter_level_pct ?? null,
          drawerFull: lAttrs.is_waste_drawer_full === true,
        }
      : null,
    feeder: fAttrs
      ? {
          online: fAttrs.online !== false,
          nextFeedUtc: fAttrs.next_feed_time_utc ?? null,
        }
      : null,
    lastFeedMs:
      countBumpMs != null ? Math.max(countBumpMs, lastFeedMs ?? 0) : lastFeedMs,
    lastCycleMs,
  })

  const celebrate = mood.animate && !prefersReducedMotion()

  return (
    <section className="card mood-card" aria-label="Chutku's mood">
      <div className={celebrate ? 'mood-mascot mood-bounce' : 'mood-mascot'}>
        <ChutkuCat pose={mood.pose} size={86} />
        {celebrate && (
          <span className="mood-hearts" aria-hidden="true">
            <i>♥</i>
            <i>♥</i>
            <i>♥</i>
          </span>
        )}
      </div>
      <div className="mood-text">
        <p className="mood-title">{mood.title}</p>
        {mood.sub && <p className="mood-sub">{mood.sub}</p>}
      </div>
    </section>
  )
}
