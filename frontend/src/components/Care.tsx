import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { isLrFault, relTime } from '../format'
import {
  CARE_TASKS,
  careReminders,
  careStatuses,
  deviceReminders,
  PET_TARGET,
  type CareStatus,
  type CareTaskKey,
  type Reminder,
} from '../insights'
import type { DeviceEntry, EventOut, FeederAttrs, LitterAttrs } from '../types'

// Owner care log + reminders (owner request 2026-07-06): brushing daily,
// nail trims monthly, evening playtime daily, pets 3+/day — plus an in-app
// "needs you" list combining due care with device needs (litter low, drawer
// full, food low, jams, offline). True PUSH notifications are M8 (they need
// the HTTPS service worker); this is the always-honest in-app version.

const WINDOW_DAYS = 45 // nails is a 30-day cadence; fetch a little past it
const DAY_MS = 86_400_000

export interface CareModel {
  statuses: CareStatus[]
  reminders: Reminder[]
  loggedNotice: string | null
  log: (task: CareTaskKey) => Promise<void>
}

/** One fetch of the care rows shared by both cards; relogs refresh it. */
export function useCare(
  litter?: DeviceEntry,
  feeder?: DeviceEntry,
  nowMs: number = Date.now(),
): CareModel {
  const [events, setEvents] = useState<EventOut[]>([])
  const [refresh, setRefresh] = useState(0)
  const [loggedNotice, setLoggedNotice] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString()
    api
      .events({ device: 'care', since, limit: 500 })
      .then((r) => !stale && setEvents(r.events))
      .catch(() => {}) // unknown history → statuses stay honest-neutral
    return () => {
      stale = true
    }
  }, [refresh])

  // background-return: the other phone may have logged care meanwhile
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') setRefresh((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    if (!loggedNotice) return
    const t = setTimeout(() => setLoggedNotice(null), 2500)
    return () => clearTimeout(t)
  }, [loggedNotice])

  const log = useCallback(async (task: CareTaskKey) => {
    const def = CARE_TASKS.find((d) => d.key === task)!
    try {
      await api.careLog(task)
      setLoggedNotice(`${def.emoji} logged ✓`)
      setRefresh((k) => k + 1)
    } catch (err) {
      setLoggedNotice(`Couldn't log: ${(err as Error).message}`)
    }
  }, [])

  const statuses = careStatuses(events, nowMs)
  const lAttrs = litter?.state?.attributes as LitterAttrs | undefined
  const fAttrs = feeder?.state?.attributes as FeederAttrs | undefined
  const reminders = [
    ...deviceReminders({
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
            foodLow: fAttrs.food_low === true,
            blocked: fAttrs.dispenser_blocked === true,
          }
        : null,
    }),
    ...careReminders(statuses, nowMs),
  ]

  return { statuses, reminders, loggedNotice, log }
}

/** "Needs you" — devices first (they're actionable now), care after. */
export function RemindersCard({ reminders }: { reminders: Reminder[] }) {
  return (
    <section className="card rem-card" aria-label="Reminders">
      <span className="den-seclabel">Needs you</span>
      {reminders.length === 0 ? (
        <p className="rem-empty">Nothing right now — all cozy 🐾</p>
      ) : (
        <ul className="rem-list">
          {reminders.map((r, i) => (
            <li key={i} className={`rem-item rem-${r.kind}`}>
              <span aria-hidden="true">{r.icon}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function statusText(s: CareStatus): { text: string; cls: string } {
  if (s.key === 'pet') {
    return s.done
      ? { text: `${s.countToday} of ${PET_TARGET} today ✓`, cls: 'ok' }
      : { text: `${s.countToday} of ${PET_TARGET} today`, cls: 'mut' }
  }
  if (s.done) {
    return {
      text: `done ${s.lastMs ? relTime(new Date(s.lastMs).toISOString()) : ''} ✓`,
      cls: 'ok',
    }
  }
  if (s.key === 'nails' || s.key === 'water') {
    return s.lastMs == null
      ? {
          text:
            s.key === 'nails'
              ? 'log his first trim to start the clock'
              : 'log a change to start the clock',
          cls: 'mut',
        }
      : {
          text: `last ${relTime(new Date(s.lastMs).toISOString())}`,
          cls: 'warn',
        }
  }
  return { text: 'not yet today', cls: 'mut' }
}

/** The manual log — one row per task, one obvious button each. */
export function CareCard({
  statuses,
  loggedNotice,
  onLog,
}: {
  statuses: CareStatus[]
  loggedNotice: string | null
  onLog: (task: CareTaskKey) => void
}) {
  return (
    <section className="card care-card" aria-label="Care log">
      <div className="card-head">
        <h2>💛 Care</h2>
        {loggedNotice && <span className="notice ok">{loggedNotice}</span>}
      </div>
      <ul className="care-list">
        {CARE_TASKS.map((def) => {
          const s = statuses.find((x) => x.key === def.key)!
          const st = statusText(s)
          return (
            <li key={def.key} className="care-row">
              <span className="care-emoji" aria-hidden="true">
                {def.emoji}
              </span>
              <span className="care-text">
                <span className="care-label">{def.label}</span>
                <span className={`care-status ${st.cls}`}>
                  {st.text} <small className="mut">· {def.cadence}</small>
                </span>
              </span>
              <button
                className="care-log-btn"
                onClick={() => onLog(def.key)}
                aria-label={`Log: ${def.label}`}
              >
                Log
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
