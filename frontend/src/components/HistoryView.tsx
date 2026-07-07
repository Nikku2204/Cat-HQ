import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { fmtDay, fmtTime, isLrFault, lrStatus } from '../format'
import type { EventOut } from '../types'

const PAGE = 50
// device filters + one type filter (power events span plug devices)
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'litterrobot', label: 'Litter' },
  { key: 'feeder', label: 'Food' },
  { key: 'care', label: 'Care' },
  { key: 'power', label: 'Power' },
] as const
export type FilterKey = (typeof FILTERS)[number]['key']

function filterParams(filter: FilterKey): { device?: string; type?: string } {
  if (filter === 'all') return {}
  if (filter === 'power') return { type: 'power' }
  return { device: filter }
}

function describe(e: EventOut): { icon: string; text: string } {
  const d = e.data
  const s = (k: string) => String(d[k] ?? '?')
  switch (e.event_type) {
    case 'feed': {
      const p = Number(d['portions'] ?? 0)
      return { icon: '🍽️', text: `Served ${p} snack${p === 1 ? '' : 's'}` }
    }
    case 'activity':
      return { icon: '📋', text: s('action') }
    case 'status_change':
      return { icon: '🔄', text: `${lrStatus(d['from'])} → ${lrStatus(d['to'])}` }
    case 'drawer_level_change':
      return { icon: '🗑️', text: `Waste drawer ${s('from')}% → ${s('to')}%` }
    case 'drawer_full':
      return {
        icon: '🗑️',
        text: d['to'] ? 'Waste drawer FULL' : 'Waste drawer emptied',
      }
    case 'litter_level_change':
      return { icon: '⏳', text: `Litter level ${s('from')} → ${s('to')}` }
    case 'pet_weight':
      return { icon: '⚖️', text: `Chutku weighed ${s('to')} lb` }
    case 'connectivity':
      return { icon: '📶', text: d['to'] ? 'Back online' : 'Went offline' }
    case 'health_change': {
      const detail = d['detail'] ? ` — ${s('detail')}` : ''
      return { icon: '🩺', text: `Adapter ${s('from')} → ${s('to')}${detail}` }
    }
    case 'food_low':
      return { icon: '🍚', text: d['to'] ? 'Food low' : 'Food level OK again' }
    case 'dispenser_blocked':
      return { icon: '⚠️', text: d['to'] ? 'Dispenser blocked' : 'Dispenser cleared' }
    case 'running_state':
      return { icon: '⚙️', text: `Bowl ${s('from')} → ${s('to')}` }
    case 'feed_count_change':
      return { icon: '🍽️', text: `Snacks today: ${s('from')} → ${s('to')}` }
    // Owner care log (2026-07-06): brush/nails/play/pet via POST /care
    case 'care': {
      const CARE_TEXT: Record<string, { icon: string; text: string }> = {
        brush: { icon: '🪮', text: 'Brushed his hair' },
        nails: { icon: '✂️', text: 'Trimmed his nails' },
        play: { icon: '🧶', text: 'Playtime!' },
        pet: { icon: '💛', text: 'Pets and cuddles' },
        water: { icon: '💧', text: 'Changed the water filter' },
      }
      return CARE_TEXT[s('task')] ?? { icon: '💛', text: `Care: ${s('task')}` }
    }
    // M5.5: mains power events, rendered distinctly. Two honest sources:
    // "command" rows from the adapter's power sequence, "poll" rows from
    // observed state diffs (e.g. a toggle in the Govee app).
    case 'power': {
      if (d['command']) {
        const cmd = s('command')
        const step = s('step')
        // user-facing names: power_cycle is a "restart" in the UI
        const cmdLabel =
          cmd === 'power_cycle'
            ? 'Restart'
            : cmd === 'power_on'
              ? 'Switch on'
              : 'Switch off'
        if (step === 'failed') {
          const during = d['during'] ? ` during ${s('during')}` : ''
          return { icon: '⚡', text: `${cmdLabel} FAILED${during}: ${s('error')}` }
        }
        if (cmd === 'power_cycle') {
          return {
            icon: '⚡',
            text:
              step === 'off'
                ? `Restart — powered off (${s('delay_s')}s)`
                : 'Restart — powered back on',
          }
        }
        return { icon: '⚡', text: cmd === 'power_on' ? 'Plug switched ON' : 'Plug switched OFF' }
      }
      return { icon: '⚡', text: `Plug ${d['to'] ? 'on' : 'off'} (observed)` }
    }
    default:
      return { icon: '•', text: `${e.event_type} ${JSON.stringify(d)}` }
  }
}

/** Rows that deserve the red fault treatment (docs/05 Part B item 6). */
function isFaultEvent(e: EventOut): boolean {
  const d = e.data
  switch (e.event_type) {
    case 'status_change':
      return isLrFault(d['to'])
    case 'drawer_full':
    case 'dispenser_blocked':
      return Boolean(d['to'])
    case 'health_change':
      return d['to'] === 'error'
    case 'power':
      return d['step'] === 'failed'
    default:
      return false
  }
}

function deviceChip(deviceId: string): { label: string; cls: string } {
  if (deviceId === 'litterrobot') return { label: 'litter', cls: 'dev-litterrobot' }
  if (deviceId.startsWith('plug_')) return { label: 'plug', cls: 'dev-plug' }
  if (deviceId === 'care') return { label: 'care', cls: 'dev-care' }
  return { label: deviceId, cls: `dev-${deviceId}` }
}

/** `initialFilter` lets other views deep-link into a pre-filtered Diary
 *  (M5.7: tapping a Den vitals tile jumps to that metric's story). The pane
 *  remounts on tab switch, so this is read fresh each navigation. */
export default function HistoryView({
  initialFilter = 'all',
}: {
  initialFilter?: FilterKey
} = {}) {
  const [filter, setFilter] = useState<FilterKey>(initialFilter)
  const [events, setEvents] = useState<EventOut[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  // bumped on every filter switch; in-flight responses from an older
  // generation are dropped instead of clobbering the new filter's list
  const generation = useRef(0)

  const load = useCallback(
    async (append: boolean) => {
      const gen = generation.current
      setLoading(true)
      setError(null)
      try {
        const base = append && events.length > 0 ? events : []
        const r = await api.events({
          ...filterParams(filter),
          limit: PAGE,
          // `until` is inclusive — the boundary event comes back again and
          // is dropped by the id-dedupe below.
          until: append ? base[base.length - 1]?.ts_utc : undefined,
        })
        if (gen !== generation.current) return
        const seen = new Set(base.map((e) => e.id))
        const fresh = r.events.filter((e) => !seen.has(e.id))
        setEvents([...base, ...fresh])
        setExhausted(fresh.length === 0 || r.events.length < PAGE)
      } catch (err) {
        if (gen === generation.current) setError((err as Error).message)
      } finally {
        if (gen === generation.current) setLoading(false)
      }
    },
    [filter, events],
  )

  useEffect(() => {
    generation.current += 1
    setEvents([])
    setExhausted(false)
    let stale = false
    setLoading(true)
    setError(null)
    api
      .events({ ...filterParams(filter), limit: PAGE })
      .then((r) => {
        if (stale) return
        setEvents(r.events)
        setExhausted(r.events.length < PAGE)
      })
      .catch((err) => !stale && setError((err as Error).message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [filter])

  let lastDay = ''
  return (
    <section className="history">
      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? 'chip active' : 'chip'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="banner banner-bad">{error}</div>}
      {!error && events.length === 0 && !loading && (
        <p className="muted center">Nothing in the diary yet 🐾</p>
      )}

      <ul className="event-list">
        {events.map((e) => {
          const day = fmtDay(e.ts_utc)
          const header = day !== lastDay ? day : null
          lastDay = day
          const { icon, text } = describe(e)
          const chip = deviceChip(e.device_id)
          const fault = isFaultEvent(e)
          return (
            <li key={e.id}>
              {header && <div className="day-head">{header}</div>}
              <div className={fault ? 'event-row event-fault' : 'event-row'}>
                <span className={`event-icon evicon ${chip.cls}`}>{icon}</span>
                <span className="event-text">{text}</span>
                <span className={`event-dev ${chip.cls}`}>{chip.label}</span>
                <span className="event-time">{fmtTime(e.ts_utc)}</span>
              </div>
            </li>
          )
        })}
      </ul>

      {!exhausted && events.length > 0 && (
        <button className="btn ghost" disabled={loading} onClick={() => load(true)}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  )
}
